/**
 * Agent loop:单循环 ReAct。
 *
 *   loop:
 *     RequestPipeline.run(ctx)       — 拼装 systemPrompt + tools(stage 化预处理)
 *     llm.stream(messages, tools)
 *       → emit text → 累计 assistant 消息
 *       → 收到 tool_call → 累计
 *       → finish
 *     if no tool_calls: break
 *     for each tool_call:
 *       PreToolUse hook(可阻断 / 改写 args)
 *       check permission → execute
 *       ResultPipeline.run(ctx)      — 截断 / 检测二进制 / summary / 错误归一化
 *       PostToolUse hook(可改写 content / summary)
 *       push tool result
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2 / §4.3。
 */

import type { LLMClient, LLMEvent } from "../llm/types.js";
import type { Message, AssistantMessage, ContentPart, ToolUsePart, TokenUsage } from "../types/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolExecuteResult } from "../tools/types.js";
import type { PermissionGate, Decision, PermissionDecision } from "../permission/index.js";
import type { Session } from "../session/jsonl.js";
import { TodoStore } from "./todos.js";
import { log } from "../log/index.js";
import type { Pipeline } from "../preprocess/pipeline.js";
import { PipelineBlockedError } from "../preprocess/pipeline.js";
import type { RequestCtx, RequestServices } from "../preprocess/request/index.js";
import { createRequestCtx, BudgetExceededError } from "../preprocess/request/index.js";
import { countMessages } from "../preprocess/tokenize.js";
import { compactMessages } from "./context.js";
import type { ResultCtx, ResultPreprocessSettings } from "../preprocess/result/index.js";
import { createResultCtx } from "../preprocess/result/index.js";
import type { HooksConfig } from "../preprocess/hooks.js";
import { runHooks } from "../preprocess/hooks.js";
import type { PreprocessLogger } from "../preprocess/types.js";

/**
 * 合并 0..N 个 AbortSignal:任一 aborted → 返回的 signal aborted。
 * 全 undefined 时返 undefined,保持 LLM stream 的"无中断"行为不变。
 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const combined = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      combined.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => combined.abort(s.reason), { once: true });
  }
  return combined.signal;
}

/**
 * 判断是否 AbortError(node fetch / execa / undici / spec / Vercel SDK 几种风格都覆盖)。
 *
 * 之前用 name === "AbortError" 漏检了 Vercel AI SDK 在 abort 时抛的
 * "This operation was aborted" 错(name 是 APICallError / DOMException 等),
 * 加 message 关键字兜底。
 */
function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const code = (err as Error & { code?: string }).code;
    if (code === "ABORT_ERR" || code === "ECANCELED") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("aborted") || msg.includes("cancelled") || msg.includes("canceled")) return true;
  }
  return false;
}

export interface AgentEvents {
  onText?: (delta: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  onToolCallArgs?: (id: string, args: unknown) => void;
  onToolResult?: (id: string, name: string, content: string, isError: boolean, summary?: string) => void;
  onPermissionRequest?: (toolName: string, args: unknown, summary: string) => Promise<PermissionDecision>;
  onAskQuestions?: (
    questions: import("../tools/builtin/ask-user-question.js").AskQuestion[],
  ) => Promise<import("../tools/builtin/ask-user-question.js").AskQuestionResponse[]>;
  onUsage?: (usage: TokenUsage) => void;
  /**
   * 流式开始前 chars/4 估算 input tokens,推给 UI 让 StatusLine/ctx 立刻显示。
   * 与 onUsage 解耦:这是"本轮 ctx 占用快照"信号,不应进 session 累计(避免重复计费)。
   * 真实 finish usage 到达时 onUsage 会再用真实 inputTokens **覆盖**(不是累加)turn 快照。
   */
  onEstimate?: (inputTokens: number) => void;
  /**
   * 队列里的 guidance 被 inject 进 messages 数组后触发(在新一轮 LLM stream 启动**之前**)。
   * UI 用来清空"待引导"小框 — 内容已经"上车"了,不再 pending。
   */
  onGuidanceInjected?: (parts: ContentPart[]) => void;
  onError?: (error: Error) => void;
  /**
   * 一段 assistant 流结束、assistantMessage 已 push 进 messages,但工具还没开始执行时触发。
   * 用于 UI 立刻把这一批 tool_use calls 显示出来——避免"流完 → 第一个 result 到达"
   * 之间用户面对空屏。turn 直接结束(无 tool calls)的场景不会触发,走 onTurnEnd。
   */
  onAssistantTurn?: () => void;
  onTurnEnd?: () => void;
  /** Pipeline 被 hook 阻断 / 致命错误时触发。 */
  onBlocked?: (reason: string) => void;
}

export interface AgentContext {
  llm: LLMClient;
  tools: ToolRegistry;
  permissions: PermissionGate;
  session: Session;
  cwd: string;
  /**
   * Legacy system prompt(向后兼容 runOneShot / 测试)。
   * 与 requestPipeline 互斥:有 pipeline 时优先 pipeline,无 pipeline 时回退到 systemPrompt + 内置 mode filter。
   */
  systemPrompt?: string;
  /** 注入式预处理:每轮 LLM 请求前跑。 */
  requestPipeline?: Pipeline<RequestCtx>;
  /** 与 requestPipeline 配套的 services(memoryIndex / provider / lang 等)。 */
  requestServices?: RequestServices;
  /** 工具结果后处理 pipeline。 */
  resultPipeline?: Pipeline<ResultCtx>;
  /** result pipeline 的运行时设置(每轮统一)。 */
  resultSettings?: ResultPreprocessSettings;
  /** 用户配置的 hooks(MVP 只跑 PreToolUse / PostToolUse)。 */
  hooks?: HooksConfig;
  /** 预处理日志器,串到 pino。 */
  hookLogger?: PreprocessLogger;
  /** Pipeline disable 列表(来自 settings.preprocess.disable)。 */
  pipelineDisable?: ReadonlyArray<string>;
  abortSignal?: AbortSignal;
  events?: AgentEvents;
  /** 注入式 TodoStore:与 requestServices.todos 共享同一实例。 */
  todos?: TodoStore;
}

export class Agent {
  private messages: Message[] = [];
  readonly todos: TodoStore;
  /** 本轮 stream 发出时的 input tokens 估算值;finish 真实 usage 回来时减去,补差量给 UI。
   *  为什么:OpenAI 兼容 stream 的 usage 只在 finish 下发,期间 StatusLine 拿不到 token 数;
   *  先用 chars/4 估算并即刻推一次 onUsage,流式中就能显示 "↑ N tokens",真实值到达时无缝覆盖。 */
  private lastEstimateInputTokens = 0;
  /** 当前轮次的 abort signal(runTurn 开始时设,结束清);runToolCall 读它给 execa 等用。 */
  private turnAbortSignal?: AbortSignal;
  /**
   * "引导(guidance)"队列:模型还在跑时用户继续输入的内容暂存这里。
   * 主循环每轮 stream 启动前 check + flush;合并成一条 role:user 注入 messages,
   * 让 LLM 在下一轮看到"已跑完的 tool result + 用户新输入"一起决策。
   *
   * 注入点:工具批跑完、下一轮 LLM stream 之前。**不打断**正在跑的工具,避免模型
   * 因丢失中间结果而重跑(用户原话:"不应该直接终止某一个小的命令或者工具执行")。
   *
   * Esc 单击时若队列非空,优先清队列(轻撤销),还有空也不 abort turn。
   */
  private pendingGuidance: ContentPart[][] = [];

  constructor(private ctx: AgentContext) {
    this.todos = ctx.todos ?? new TodoStore();
  }

  /** 估算 input tokens:走 src/preprocess/tokenize.ts(js-tiktoken cl100k_base)。
   *  比旧 chars/4 精度高,trim-history / budget-guard 也共享同一个估算口径。 */
  private estimateInputTokens(
    messages: Message[],
    systemPrompt: string,
    tools: import("../types/index.js").ToolDefinition[],
  ): number {
    return countMessages(messages, systemPrompt, tools);
  }

  getMessages(): Message[] {
    return this.messages;
  }

  setMessages(msgs: Message[]): void {
    this.messages = msgs;
  }

  /**
   * 把一段"引导"内容塞进队列。下一轮 stream 启动前会被合并成一条 role:user 注入 messages。
   * 调用方:App 的 handleSubmit 在 state.status !== "idle" 时走这条路径。
   */
  enqueueGuidance(content: string | ContentPart[]): void {
    const parts: ContentPart[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    this.pendingGuidance.push(parts);
  }

  /** 用户单击 Esc 时若队列非空,清掉(轻撤销;不 abort 当前 turn)。 */
  clearGuidance(): void {
    this.pendingGuidance.length = 0;
  }

  getPendingGuidanceCount(): number {
    return this.pendingGuidance.length;
  }

  /**
   * 把当前 pendingGuidance 合并成一条 role:user message push 进 messages,清空队列。
   * 多条 guidance 之间用空行分隔(模型把它们读成"一次性补充的几点")。
   * 返回 true 表示真的注入了内容;false 表示队列本就空。
   */
  private flushGuidance(): boolean {
    if (this.pendingGuidance.length === 0) return false;
    const queued = this.pendingGuidance;
    this.pendingGuidance = [];

    // 合并:每条 guidance 是 ContentPart[];多条之间塞一段分隔 text。
    // 优先合并所有相邻 text part 成一段(避免一堆零散 part 在 LLM 端看起来怪)。
    const merged: ContentPart[] = [];
    const SEP = "\n\n---\n\n";
    for (let i = 0; i < queued.length; i++) {
      const parts = queued[i];
      if (i > 0) {
        // 分隔符尽量并入前一段 text 末尾
        const tail = merged[merged.length - 1];
        if (tail && tail.type === "text") tail.text += SEP;
        else merged.push({ type: "text", text: SEP });
      }
      for (const p of parts) {
        const tail = merged[merged.length - 1];
        if (p.type === "text" && tail && tail.type === "text") {
          tail.text += p.text;
        } else {
          // 浅拷贝避免外部突变影响 messages
          merged.push({ ...p });
        }
      }
    }

    const guidanceMsg: Message = { role: "user", content: merged };
    this.messages.push(guidanceMsg);
    this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: guidanceMsg });
    this.ctx.events?.onGuidanceInjected?.(merged);
    return true;
  }

  /**
   * 执行一次完整的"用户输入 → 助手响应(含工具循环) → 等待下一轮输入"。
   *
   * userInput 可以是:
   *   - string:纯文本(向后兼容,无附件场景)
   *   - ContentPart[]:多 part 内容(text + file/image 附件)
   *
   * abortSignal:本轮专属信号(每轮新建,App.handleSubmit 传入);Esc 触发 abort
   * 时立刻打断 LLM stream + execa 工具 + 等待循环。优先级高于 ctx.abortSignal
   * (后者是进程级 / 启动时签名,用于全局退出)。
   */
  async runTurn(userInput: string | ContentPart[], abortSignal?: AbortSignal): Promise<void> {
    const turnSignal = combineSignals(abortSignal, this.ctx.abortSignal);
    this.turnAbortSignal = turnSignal;
    const userMessage: Message = { role: "user", content: userInput };
    this.messages.push(userMessage);
    await this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: userMessage });

    // 内部循环:工具调用可能多轮
    while (true) {
      // 上一轮 tool 跑完(或 turn 刚开始)→ stream 启动前 flush guidance 队列。
      // 注入点:已落到 messages 的"tool_result 序列"之后 + 下一轮 stream 之前,
      // 这样 LLM 在 prompt 里看到的就是「上轮工具结果 + 用户新输入」,顺势继续推进
      // 而不会因为消息丢失重跑刚才的工具。
      this.flushGuidance();

      let systemPrompt: string;
      let tools: import("../types/index.js").ToolDefinition[];
      let messagesForStream: Message[];
      try {
        const built = await this.buildRequest();
        systemPrompt = built.systemPrompt;
        tools = built.tools;
        messagesForStream = built.messages;
      } catch (err) {
        // budget-guard 抛 BudgetExceededError → 报给用户,turn 结束
        if (err instanceof BudgetExceededError) {
          this.ctx.events?.onError?.(err);
          log.error("budget exceeded", { msg: err.message });
          this.turnAbortSignal = undefined;
          return;
        }
        throw err;
      }

      // PreLLMRequest hook 可改写 messages / systemPrompt / tools 或 block
      try {
        const hookOut = await runHooks(
          "PreLLMRequest",
          { messages: this.messages, systemPrompt, tools, modelId: this.ctx.llm.model },
          this.ctx.hooks,
          this.ctx.hookLogger,
        );
        if (typeof hookOut.systemPrompt === "string") systemPrompt = hookOut.systemPrompt;
        if (Array.isArray(hookOut.messages)) messagesForStream = hookOut.messages as Message[];
        if (Array.isArray(hookOut.tools)) tools = hookOut.tools as import("../types/index.js").ToolDefinition[];
      } catch (err) {
        if (err instanceof PipelineBlockedError) {
          this.ctx.events?.onBlocked?.(err.reason);
          this.ctx.events?.onError?.(new Error(`PreLLMRequest blocked: ${err.reason}`));
          return;
        }
        throw err;
      }

      // 流式开始前用 chars/4 估算 input tokens 即刻推给 UI,让 StatusLine 立刻显示。
      // 走 onEstimate(不是 onUsage)避免污染 session 累计计费;finish 真实 usage 到达后
      // 上层 reducer 会用真实 inputTokens 覆盖本轮 ctx 快照(不累加)。
      const estimate = this.estimateInputTokens(messagesForStream, systemPrompt, tools);
      this.lastEstimateInputTokens = estimate;
      this.ctx.events?.onEstimate?.(estimate);

      const stream = this.ctx.llm.stream({
        messages: messagesForStream,
        tools,
        systemPrompt,
        abortSignal: turnSignal,
      });

      const assistantParts: ContentPart[] = [];
      const toolCallsToRun: ToolUsePart[] = [];
      let lastError: Error | undefined;

      try {
        for await (const ev of stream) {
          this.handleEvent(ev, assistantParts, toolCallsToRun, (e) => {
            lastError = e;
          });
          if (lastError) break;
          if (turnSignal?.aborted) break;
        }
      } catch (err) {
        if (isAbortError(err) || turnSignal?.aborted) {
          // Esc 触发的优雅中断:保留已生成的 assistant 文本 + 任何已完成的 tool_use 在 history,
          // 但**不**进入工具执行环节(toolCallsToRun 直接清空)。让 UI 看到"我已经说了一半"。
          this.persistInterruptedAssistant(assistantParts);
          this.ctx.events?.onTurnEnd?.();
          this.turnAbortSignal = undefined;
          return;
        }
        throw err;
      }

      if (lastError) {
        this.ctx.events?.onError?.(lastError);
        log.error("agent stream error", { msg: lastError.message });
        this.turnAbortSignal = undefined;
        return;
      }

      // Esc 在 stream loop 内 break 但未抛错(turnSignal.aborted)
      if (turnSignal?.aborted) {
        this.persistInterruptedAssistant(assistantParts);
        this.ctx.events?.onTurnEnd?.();
        this.turnAbortSignal = undefined;
        return;
      }

      // 把 assistant 消息加入历史
      const assistantMessage: AssistantMessage = { role: "assistant", content: assistantParts };
      this.messages.push(assistantMessage);
      await this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: assistantMessage });

      // PostLLMResponse hook(不阻断,仅审计 / 镜像;返回值忽略)
      const assistantText = assistantParts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      const toolCalls = toolCallsToRun.map((t) => ({ id: t.id, name: t.name, args: t.args }));
      try {
        await runHooks(
          "PostLLMResponse",
          { assistantText, toolCalls },
          this.ctx.hooks,
          this.ctx.hookLogger,
        );
      } catch (err) {
        if (err instanceof PipelineBlockedError) {
          log.warn("PostLLMResponse tried to block, ignored", { reason: err.reason });
        } else {
          throw err;
        }
      }

      if (toolCallsToRun.length === 0) {
        // 模型刚说完一段 text 没要工具——本该 turn 结束。但若用户在生成期间塞了 guidance
        // 进队列,把"结束"折叠成"继续下一轮":循环顶上 flushGuidance 会把它注入成新的
        // user message,LLM 在新一轮 stream 里基于"刚答完的内容 + 用户追问"自然推进。
        if (this.pendingGuidance.length > 0) continue;
        this.ctx.events?.onTurnEnd?.();
        this.turnAbortSignal = undefined;
        return;
      }

      // 流刚结束、tool 还没跑——给 UI 一个钩子立刻展示这一批 calls
      this.ctx.events?.onAssistantTurn?.();

      // 执行工具调用;每个工具开始前再检查 abort,避免 stream 中断后还硬跑工具。
      // 每个工具跑完后 yield 一次 event loop:让 React commit + Ink paint 完成,
      // 避免快速本地工具(ls/cat 等 ~30ms)让 React 18 auto-batching 把多次 history_set
      // 合并成单次 commit——那样用户会错过 active row 切换的全部中间帧。
      for (const call of toolCallsToRun) {
        if (turnSignal?.aborted) {
          this.recordToolResult(call.id, call.name, `Interrupted by user (Esc).`, true);
        } else {
          await this.runToolCall(call);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      // 工具循环跑完后若已 abort,本轮直接收尾,不再开新一轮 LLM stream
      if (turnSignal?.aborted) {
        this.ctx.events?.onTurnEnd?.();
        this.turnAbortSignal = undefined;
        return;
      }
    }
  }

  /** 拼装本轮 system prompt + tools(+ 可能 trim 后的 messages)。
   *  优先走 RequestPipeline,无 pipeline 时回退到 legacy 路径。
   *
   *  注意:trim-history 可能替换 ctx.messages,这里把它回流出去给主循环作为
   *  messagesForStream。**不污染** this.messages — 因为 trim 是临时为本次请求
   *  做的窗口缩减,真正的历史不动(budget-guard 触发的 compact 例外:那是
   *  通过 services.compact 真实写回 this.messages 的)。 */
  private async buildRequest(): Promise<{
    systemPrompt: string;
    tools: import("../types/index.js").ToolDefinition[];
    messages: Message[];
  }> {
    if (this.ctx.requestPipeline && this.ctx.requestServices) {
      const ctx = createRequestCtx({
        messages: this.messages,
        modelId: this.ctx.llm.model,
        mode: this.ctx.permissions.getMode(),
        cwd: this.ctx.cwd,
        services: {
          ...this.ctx.requestServices,
          todos: this.todos,
          contextWindow: this.ctx.llm.capabilities.maxContextWindow,
          abortSignal: this.turnAbortSignal,
          // compact 闭包:budget-guard 触发时调用。真实改写 this.messages
          // (compact 是历史压缩,不可逆,要落到 agent state)。
          compact: async (signal) => {
            // I-5 联动:传 cwd 触发 facts 自动 promote 到 long-term memory
            const result = await compactMessages(this.messages, {
              llm: this.ctx.llm,
              abortSignal: signal,
              hooks: this.ctx.hooks,
              cwd: this.ctx.cwd,
            });
            this.messages = result.newMessages;
            return this.messages;
          },
        },
      });
      await this.ctx.requestPipeline.run(ctx);
      return { systemPrompt: ctx.systemPrompt, tools: ctx.tools, messages: ctx.messages };
    }
    // Legacy fallback
    const mode = this.ctx.permissions.getMode();
    const tools = this.ctx.tools.toLLMDefinitions(
      mode === "plan" ? (t) => t.permission === "read" : undefined,
    );
    const todoSection = this.todos.toPromptSection();
    const base = this.ctx.systemPrompt ?? "";
    const systemPrompt = todoSection ? `${base}\n\n${todoSection}` : base;
    return { systemPrompt, tools, messages: this.messages };
  }

  private handleEvent(
    ev: LLMEvent,
    assistantParts: ContentPart[],
    toolCallsToRun: ToolUsePart[],
    onError: (e: Error) => void,
  ): void {
    switch (ev.type) {
      case "text":
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
          // 推 delta:已经通过 estimate 注入了 lastEstimateInputTokens,这里只补 (real - estimate);
          // outputTokens 没估算过,直接推真实值。
          const adjusted: TokenUsage = {
            inputTokens: ev.usage.inputTokens - this.lastEstimateInputTokens,
            outputTokens: ev.usage.outputTokens,
            totalTokens: ev.usage.totalTokens - this.lastEstimateInputTokens,
          };
          this.ctx.events?.onUsage?.(adjusted);
          this.ctx.session.append({
            type: "usage",
            time: new Date().toISOString(),
            usage: ev.usage, // session 写真实值,不写 estimate
            provider: this.ctx.llm.providerName,
            model: this.ctx.llm.model,
          });
        }
        this.lastEstimateInputTokens = 0; // 不论 usage 是否回都复位,下一轮 stream 重新估
        break;

      case "error":
        onError(ev.error);
        break;
    }
  }

  /** Esc 中断时:把"已经流出来"的 assistant 内容存进 history,标 [interrupted] 后缀。 */
  private persistInterruptedAssistant(parts: ContentPart[]): void {
    const cleanedParts: ContentPart[] = parts.filter((p) => p.type !== "tool_use");
    // 在最后一段 text 末尾追加 [interrupted] 标识;无 text 时新建一段
    const lastIdx = cleanedParts.length - 1;
    if (lastIdx >= 0 && cleanedParts[lastIdx].type === "text") {
      const t = cleanedParts[lastIdx] as { type: "text"; text: string };
      cleanedParts[lastIdx] = { type: "text", text: `${t.text}\n\n[interrupted]` };
    } else {
      cleanedParts.push({ type: "text", text: "[interrupted]" });
    }
    const assistantMessage: AssistantMessage = { role: "assistant", content: cleanedParts };
    this.messages.push(assistantMessage);
    this.ctx.session.append({ type: "message", time: new Date().toISOString(), message: assistantMessage });
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
    }

    // PreToolUse hook 可改写 args 或阻断
    let effectiveArgs = call.args;
    try {
      const hookOut = await runHooks(
        "PreToolUse",
        { toolName: call.name, args: effectiveArgs },
        this.ctx.hooks,
        this.ctx.hookLogger,
      );
      if (hookOut.args !== undefined) effectiveArgs = hookOut.args;
    } catch (err) {
      if (err instanceof PipelineBlockedError) {
        this.ctx.events?.onBlocked?.(err.reason);
        this.recordToolResult(call.id, call.name, `Blocked by PreToolUse hook: ${err.reason}`, true);
        return;
      }
      throw err;
    }

    const toolCtx: ToolContext = {
      cwd: this.ctx.cwd,
      abortSignal: this.turnAbortSignal ?? this.ctx.abortSignal,
      askPermission: async () => true, // 已在外层处理
      todos: this.todos,
      askQuestions: this.ctx.events?.onAskQuestions
        ? (qs) => this.ctx.events!.onAskQuestions!(qs)
        : undefined,
    };

    const raw: ToolExecuteResult = await this.ctx.tools.execute(call.name, effectiveArgs, toolCtx);

    // ResultPipeline 后处理 + PostToolUse hook
    const processed = await this.postProcessResult({
      toolName: call.name,
      toolUseId: call.id,
      args: effectiveArgs,
      raw,
    });

    this.recordToolResult(
      call.id,
      call.name,
      processed.content,
      processed.isError,
      processed.summary,
      processed.diff,
      processed.kind,
    );
  }

  private async postProcessResult(input: {
    toolName: string;
    toolUseId: string;
    args: unknown;
    raw: ToolExecuteResult;
  }): Promise<{ content: string; isError: boolean; summary?: string; diff?: string; kind?: "success" | "error" | "warn" }> {
    let content = input.raw.content;
    let summary = input.raw.summary;
    let diff = input.raw.diff;
    const isError = input.raw.isError ?? false;
    let kind = input.raw.kind;

    if (this.ctx.resultPipeline) {
      const rctx = createResultCtx({
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        args: input.args,
        raw: input.raw,
        settings: this.ctx.resultSettings,
      });
      try {
        await this.ctx.resultPipeline.run(rctx);
        content = rctx.content;
        summary = rctx.summary;
        diff = rctx.diff;
      } catch (err) {
        log.warn("result pipeline error", { msg: (err as Error).message });
      }
    }

    // PostToolUse hook(默认不阻断,仅改写 content / summary)
    try {
      const hookOut = await runHooks(
        "PostToolUse",
        { toolName: input.toolName, args: input.args, content, summary, isError },
        this.ctx.hooks,
        this.ctx.hookLogger,
      );
      if (typeof hookOut.content === "string") content = hookOut.content;
      if (typeof hookOut.summary === "string") summary = hookOut.summary;
    } catch (err) {
      if (err instanceof PipelineBlockedError) {
        // PostToolUse 不允许阻断;降级为告警
        log.warn("PostToolUse hook tried to block, ignored", { reason: err.reason });
      } else {
        throw err;
      }
    }

    return { content, isError, summary, diff, kind };
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
