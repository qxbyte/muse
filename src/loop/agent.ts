/**
 * Agent loop：单循环 ReAct。
 *
 *   loop:
 *     llm.stream(messages, tools)
 *       → emit text → 累计 assistant 消息
 *       → 收到 tool_call → 累计
 *       → finish
 *     if no tool_calls: break
 *     for each tool_call:
 *       check permission → execute → push tool result
 */

import type { LLMClient, LLMEvent } from "../llm/types.js";
import type { Message, AssistantMessage, ContentPart, ToolUsePart, TokenUsage } from "../types/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { PermissionGate, Decision, PermissionDecision } from "../permission/index.js";
import type { Session } from "../session/jsonl.js";
import { TodoStore } from "./todos.js";
import { log } from "../log/index.js";

export interface AgentEvents {
  onText?: (delta: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  onToolCallArgs?: (id: string, args: unknown) => void;
  onToolResult?: (id: string, name: string, content: string, isError: boolean, summary?: string) => void;
  onPermissionRequest?: (toolName: string, args: unknown, summary: string) => Promise<PermissionDecision>;
  onUsage?: (usage: TokenUsage) => void;
  onError?: (error: Error) => void;
  onTurnEnd?: () => void;
}

export interface AgentContext {
  llm: LLMClient;
  tools: ToolRegistry;
  permissions: PermissionGate;
  session: Session;
  cwd: string;
  systemPrompt: string;
  abortSignal?: AbortSignal;
  events?: AgentEvents;
}

export class Agent {
  private messages: Message[] = [];
  readonly todos = new TodoStore();

  constructor(private ctx: AgentContext) {}

  getMessages(): Message[] {
    return this.messages;
  }

  setMessages(msgs: Message[]): void {
    this.messages = msgs;
  }

  /** 执行一次完整的"用户输入 → 助手响应（含工具循环） → 等待下一轮输入"。 */
  async runTurn(userInput: string): Promise<void> {
    const userMessage: Message = { role: "user", content: userInput };
    this.messages.push(userMessage);
    await this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: userMessage });

    // 内部循环：工具调用可能多轮
    while (true) {
      const mode = this.ctx.permissions.getMode();
      const tools = this.ctx.tools.toLLMDefinitions(
        mode === "plan" ? (t) => t.permission === "read" : undefined,
      );
      // 每轮把当前 todos 注入 system prompt 末尾，让 LLM 看到自己写的清单
      const todoSection = this.todos.toPromptSection();
      const systemPrompt = todoSection
        ? `${this.ctx.systemPrompt}\n\n${todoSection}`
        : this.ctx.systemPrompt;
      const stream = this.ctx.llm.stream({
        messages: this.messages,
        tools,
        systemPrompt,
        abortSignal: this.ctx.abortSignal,
      });

      const assistantParts: ContentPart[] = [];
      const toolCallsToRun: ToolUsePart[] = [];
      let lastError: Error | undefined;

      for await (const ev of stream) {
        this.handleEvent(ev, assistantParts, toolCallsToRun, (e) => {
          lastError = e;
        });
        if (lastError) break;
      }

      if (lastError) {
        this.ctx.events?.onError?.(lastError);
        log.error("agent stream error", { msg: lastError.message });
        return;
      }

      // 把 assistant 消息加入历史
      const assistantMessage: AssistantMessage = { role: "assistant", content: assistantParts };
      this.messages.push(assistantMessage);
      await this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: assistantMessage });

      if (toolCallsToRun.length === 0) {
        this.ctx.events?.onTurnEnd?.();
        return;
      }

      // 执行工具调用
      for (const call of toolCallsToRun) {
        await this.runToolCall(call);
      }
    }
  }

  private handleEvent(
    ev: LLMEvent,
    assistantParts: ContentPart[],
    toolCallsToRun: ToolUsePart[],
    onError: (e: Error) => void,
  ): void {
    switch (ev.type) {
      case "text":
        // 合并到最后一个 text part 或新增
        {
          const last = assistantParts[assistantParts.length - 1];
          if (last && last.type === "text") {
            last.text += ev.delta;
          } else {
            assistantParts.push({ type: "text", text: ev.delta });
          }
        }
        this.ctx.events?.onText?.(ev.delta);
        break;

      case "tool_call_start":
        this.ctx.events?.onToolCallStart?.(ev.id, ev.name);
        break;

      case "tool_call_complete": {
        const callPart: ToolUsePart = { type: "tool_use", id: ev.id, name: ev.name, args: ev.args };
        assistantParts.push(callPart);
        toolCallsToRun.push(callPart);
        this.ctx.events?.onToolCallArgs?.(ev.id, ev.args);
        break;
      }

      case "finish":
        if (ev.usage) {
          this.ctx.events?.onUsage?.(ev.usage);
          this.ctx.session.append({
            type: "usage",
            time: new Date().toISOString(),
            usage: ev.usage,
            provider: this.ctx.llm.providerName,
            model: this.ctx.llm.model,
          });
        }
        break;

      case "error":
        onError(ev.error);
        break;
    }
  }

  private async runToolCall(call: ToolUsePart): Promise<void> {
    const tool = this.ctx.tools.get(call.name);
    if (!tool) {
      const result = `Tool "${call.name}" is not available.`;
      this.recordToolResult(call.id, call.name, result, true);
      return;
    }

    const summary = tool.summarize?.(call.args) ?? `${call.name}(...)`;
    const decision: Decision = this.ctx.permissions.decide({
      toolName: call.name,
      args: call.args,
      permission: tool.permission,
    });

    let approved = decision === "allow";
    if (decision === "deny") {
      const reason =
        this.ctx.permissions.getMode() === "plan"
          ? `Denied: you are in plan mode. Only read-only tools are available. Propose changes instead of executing.`
          : `Denied by policy: ${call.name}.`;
      this.recordToolResult(call.id, call.name, reason, true);
      return;
    }
    if (decision === "ask") {
      const userDecision =
        (await this.ctx.events?.onPermissionRequest?.(call.name, call.args, summary)) ?? "no";
      if (userDecision === "no") {
        this.recordToolResult(call.id, call.name, `User rejected ${call.name}.`, true);
        return;
      }
      if (userDecision === "session_allow") {
        this.ctx.permissions.allowForSession(call.name);
      }
      approved = true;
    }

    const toolCtx: ToolContext = {
      cwd: this.ctx.cwd,
      abortSignal: this.ctx.abortSignal,
      askPermission: async () => true, // 已在外层处理
      todos: this.todos,
    };

    const result = await this.ctx.tools.execute(call.name, call.args, toolCtx);
    this.recordToolResult(call.id, call.name, result.content, result.isError ?? false, result.summary, result.diff, result.kind);
  }

  private recordToolResult(
    id: string,
    name: string,
    content: string,
    isError: boolean,
    summary?: string,
    diff?: string,
    kind?: "success" | "error" | "warn",
  ): void {
    const toolMsg: Message = {
      role: "tool",
      toolUseId: id,
      content,
      isError,
      toolName: name,
      ...(diff ? { diff } : {}),
      ...(summary ? { summary } : {}),
      ...(kind ? { kind } : {}),
    };
    this.messages.push(toolMsg);
    this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: toolMsg });
    this.ctx.events?.onToolResult?.(id, name, content, isError, summary);
  }
}
