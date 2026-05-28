/**
 * 上下文管理：手动 / 自动压缩对话历史。
 *
 * 设计文档：muse-design.md §5.3 上下文管理。
 *
 * 算法：
 *   1. 找一个安全切割点 cutoff：cutoff 之前是 "older"，之后是 "recent"
 *   2. 安全 = 不破坏 assistant 的 tool_use ↔ 紧随的 tool 消息 配对
 *      （在 tool_use 之后但 tool result 之前切，会让 LLM 看到悬挂的 tool_use）
 *   3. older 拼成转录，调 LLM 摘要成一段
 *   4. 摘要包成一条 user message（"[Previous conversation summary] ..."），
 *      作为新历史的开头，后接 recent
 *
 * Why user 角色而非 system：
 *   - 系统提示 muse 已在 systemPrompt 单独管理；不污染它
 *   - 用 user role 让 LLM 自然把它当成"任务上下文"继续推理
 */

import type { LLMClient } from "../llm/types.js";
import type { Message, AssistantMessage, ContentPart } from "../types/index.js";

export interface CompactOptions {
  llm: LLMClient;
  /** 保留最近 N 条原始消息不压缩。默认 4。 */
  keepRecent?: number;
  abortSignal?: AbortSignal;
}

export interface CompactResult {
  newMessages: Message[];
  summary: string;
  originalCount: number;
  newCount: number;
  /** 没有可压缩内容时为 true，messages 原样返回。 */
  noop: boolean;
}

export async function compactMessages(
  messages: Message[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const keepRecent = opts.keepRecent ?? 4;
  const cutoff = findSafeCutoff(messages, keepRecent);

  if (cutoff <= 0) {
    return {
      newMessages: messages,
      summary: "",
      originalCount: messages.length,
      newCount: messages.length,
      noop: true,
    };
  }

  const older = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);
  const summary = await summarizeConversation(older, opts.llm, opts.abortSignal);

  const summaryMessage: Message = {
    role: "user",
    content:
      `[Previous conversation summary]\n\n${summary}\n\n` +
      `[End of summary. The conversation continues below.]`,
  };

  const newMessages: Message[] = [summaryMessage, ...recent];

  return {
    newMessages,
    summary,
    originalCount: messages.length,
    newCount: newMessages.length,
    noop: false,
  };
}

/**
 * 从理想切点（messages.length - keepRecent）向前找最近的安全边界。
 * 安全边界 = user 消息（自然 turn 起点），且其之前不存在悬挂的 tool_use。
 *
 * 退化策略：找不到合法切点 → 返回 0（不压缩）。
 */
export function findSafeCutoff(messages: Message[], keepRecent: number): number {
  if (messages.length <= keepRecent) return 0;
  const ideal = Math.max(0, messages.length - keepRecent);

  for (let i = ideal; i > 0; i--) {
    if (messages[i].role !== "user") continue;
    if (hasUnresolvedToolUse(messages.slice(0, i))) continue;
    return i;
  }
  return 0;
}

/** older 段是否有 assistant.tool_use 但缺对应 tool 消息。 */
function hasUnresolvedToolUse(older: Message[]): boolean {
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();
  for (const msg of older) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool_use") seenToolUseIds.add(part.id);
      }
    } else if (msg.role === "tool") {
      seenToolResultIds.add(msg.toolUseId);
    }
  }
  for (const id of seenToolUseIds) {
    if (!seenToolResultIds.has(id)) return true;
  }
  return false;
}

async function summarizeConversation(
  older: Message[],
  llm: LLMClient,
  abortSignal?: AbortSignal,
): Promise<string> {
  const transcript = renderTranscript(older);
  const prompt: Message[] = [
    {
      role: "user",
      content:
        `Summarize the following conversation in 200-400 words. Focus on:\n` +
        `1. The user's task and goals\n` +
        `2. Key decisions and approaches taken\n` +
        `3. Files or code touched (paths + what changed)\n` +
        `4. Outstanding questions or pending work\n\n` +
        `Be concrete. Do not invent details. Use short bullet points where appropriate.\n\n` +
        `--- BEGIN CONVERSATION ---\n${transcript}\n--- END CONVERSATION ---`,
    },
  ];

  let text = "";
  for await (const ev of llm.stream({ messages: prompt, abortSignal })) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "error") throw ev.error;
  }
  return text.trim() || "(empty summary)";
}

function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        lines.push(`[system]\n${msg.content}\n`);
        break;
      case "user":
        lines.push(`[user]\n${typeof msg.content === "string" ? msg.content : flattenContent(msg.content)}\n`);
        break;
      case "assistant":
        lines.push(`[assistant]\n${renderAssistant(msg)}\n`);
        break;
      case "tool":
        lines.push(`[tool result${msg.isError ? " ERROR" : ""}]\n${msg.content}\n`);
        break;
    }
  }
  return lines.join("\n");
}

function renderAssistant(msg: AssistantMessage): string {
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "tool_use") {
      parts.push(`<tool_call name="${part.name}" args=${JSON.stringify(part.args)} />`);
    }
  }
  return parts.join("\n");
}

function flattenContent(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
