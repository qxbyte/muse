/**
 * 上下文管理：手动 / 自动压缩对话历史。
 *
 * 设计文档：muse-design.md §5.3 / 模块设计/上下文管理工程/设计.md §4.2 + §4.5。
 *
 * 算法：
 *   1. 找一个安全切割点 cutoff：cutoff 之前是 "older"，之后是 "recent"
 *   2. 安全 = 不破坏 assistant 的 tool_use ↔ 紧随的 tool 消息 配对
 *      （在 tool_use 之后但 tool result 之前切，会让 LLM 看到悬挂的 tool_use）
 *   3. older 拼成转录，调 LLM 摘要(I-2:9 节结构化 schema,带 facts JSON)
 *   4. 摘要剥 facts JSON 后包成一条 user message（"[Previous conversation summary] ..."），
 *      作为新历史的开头，后接 recent
 *   5. I-5:facts 经 MemoryPromote hook 后 writeMemory(trust=auto, source=compact-promote)
 *
 * Why user 角色而非 system：
 *   - 系统提示 muse 已在 systemPrompt 单独管理；不污染它
 *   - 用 user role 让 LLM 自然把它当成"任务上下文"继续推理
 */

import type { LLMClient } from "../llm/types.js";
import type { Message, AssistantMessage, ContentPart } from "../types/index.js";
import type { HooksConfig } from "../preprocess/hooks.js";
import { runHooks } from "../preprocess/hooks.js";
import { PipelineBlockedError } from "../preprocess/pipeline.js";
import {
  buildSummaryPrompt,
  extractFacts,
  stripFactsBlock,
  type ExtractedFact,
  type SummarySchema,
} from "./prompts/summarize.js";
import { writeMemory, memoryFilePath } from "./memory.js";
import { existsSync } from "node:fs";

export interface CompactOptions {
  llm: LLMClient;
  /** 保留最近 N 条原始消息不压缩。默认 4。 */
  keepRecent?: number;
  abortSignal?: AbortSignal;
  /** LLM 摘要流式过程中的字符进度回调（每个 text-delta 触发，传累计字符数）。 */
  onProgress?: (charsReceived: number) => void;
  /** PreCompact / PostCompact / MemoryPromote hooks 配置。 */
  hooks?: HooksConfig;
  /** I-2 schema 选择;默认 "9-section"。 */
  schema?: SummarySchema;
  /** O3:9-section LLM 失败时自动用 6-section 重试一次(默认 true)。 */
  fallbackOnFormatFail?: boolean;
  /** I-5 联动:本次 compact 触发的 cwd,用于 writeMemory 写到正确项目下。
   *  未提供时跳过 facts 提取(纯摘要模式)。 */
  cwd?: string;
  /** I-5:是否自动把 facts 写入 memory(默认 true)。 */
  promoteFactsToMemory?: boolean;
  /** O4:source=compact-promote 写入前检查同名 memory 是否已存在(默认 true,跳过不覆盖)。 */
  dedupPromotedFacts?: boolean;
}

export class CompactBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`compact blocked by PreCompact hook: ${reason}`);
    this.name = "CompactBlockedError";
  }
}

export interface CompactResult {
  newMessages: Message[];
  summary: string;
  originalCount: number;
  newCount: number;
  /** 没有可压缩内容时为 true，messages 原样返回。 */
  noop: boolean;
  /** I-5:被提取并尝试写入 memory 的 facts(可能被 hook block 部分)。 */
  promotedFacts?: PromotedFact[];
}

export interface PromotedFact {
  name: string;
  type: ExtractedFact["type"];
  description: string;
  /** 写入结果:
   *    "saved"   新写入
   *    "skipped" O4 dedup:同名 memory 已存在,跳过(防 LLM 反复提取把 verified 打回 auto)
   *    "blocked" MemoryPromote hook 拒绝
   *    "failed"  writeMemory 异常 */
  status: "saved" | "skipped" | "blocked" | "failed";
  reason?: string;
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

  // PreCompact hook(可 block / 用于审计)
  try {
    await runHooks(
      "PreCompact",
      { messageCount: messages.length, cutoff, keepRecent },
      opts.hooks,
    );
  } catch (err) {
    if (err instanceof PipelineBlockedError) {
      throw new CompactBlockedError(err.reason);
    }
    throw err;
  }

  const older = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);
  const schema: SummarySchema = opts.schema ?? "9-section";

  // O3:9-section 失败 → 6-section 降级重试一次(可由 fallbackOnFormatFail=false 关闭)。
  // LLM 流偶发 / 网络抖动可吸收,仍失败再抛(由 budget-guard 包成 BudgetExceededError)。
  const fallbackEnabled = opts.fallbackOnFormatFail !== false; // 默认 true
  let rawSummary: string;
  try {
    rawSummary = await summarizeConversation(older, opts.llm, schema, opts.abortSignal, opts.onProgress);
  } catch (err) {
    if (fallbackEnabled && schema === "9-section" && !opts.abortSignal?.aborted) {
      rawSummary = await summarizeConversation(older, opts.llm, "6-section", opts.abortSignal, opts.onProgress);
    } else {
      throw err;
    }
  }

  // I-2:剥 facts JSON 块,留人类可读摘要主体
  const summary = stripFactsBlock(rawSummary);
  const facts = opts.cwd ? extractFacts(rawSummary) : [];

  // O6:summary message 是占位符;facts promote 完成后会重新构造文案(在末尾追加
  // promote 结果摘要,让 UI 与 LLM 都能看到本次自动 compact 写入了哪些 memory)。
  const newMessages: Message[] = [
    { role: "user", content: renderSummaryBody(summary, undefined) },
    ...recent,
  ];

  // PostCompact hook(不阻断)
  try {
    await runHooks(
      "PostCompact",
      { before: messages.length, after: newMessages.length, summary, factCount: facts.length },
      opts.hooks,
    );
  } catch (err) {
    if (err instanceof PipelineBlockedError) {
      // PostCompact 不允许 block;降级为 no-op
    } else {
      throw err;
    }
  }

  // I-5:把 facts 写入 memory(每条走 MemoryPromote hook 审核;失败不阻塞 compact)
  let promotedFacts: PromotedFact[] | undefined;
  const shouldPromote = opts.promoteFactsToMemory !== false && opts.cwd && facts.length > 0;
  if (shouldPromote) {
    const dedup = opts.dedupPromotedFacts !== false; // 默认 true
    promotedFacts = await promoteFactsToMemory(facts, opts.cwd!, opts.hooks, dedup);
  }

  // O6:把 promote 结果摘要回写到 summary message 末尾,让用户在 history 中
  // 立即看到本次自动 compact 写了哪些 memory(LLM 也能在下一轮看到 — 防它重复提取同名 fact)。
  if (promotedFacts && promotedFacts.length > 0) {
    newMessages[0] = {
      role: "user",
      content: renderSummaryBody(summary, promotedFacts),
    };
  }

  return {
    newMessages,
    summary,
    originalCount: messages.length,
    newCount: newMessages.length,
    noop: false,
    promotedFacts,
  };
}

/** O6:渲染 summary message 内容,可选附加 promoted facts 摘要。 */
function renderSummaryBody(summary: string, facts: PromotedFact[] | undefined): string {
  const head = `[Previous conversation summary]\n\n${summary}\n\n` +
               `[End of summary. The conversation continues below.]`;
  if (!facts || facts.length === 0) return head;
  const saved = facts.filter((f) => f.status === "saved").map((f) => f.name);
  const skipped = facts.filter((f) => f.status === "skipped").map((f) => f.name);
  const blocked = facts.filter((f) => f.status === "blocked").map((f) => f.name);
  const failed = facts.filter((f) => f.status === "failed").map((f) => f.name);
  const parts: string[] = [];
  if (saved.length > 0) parts.push(`saved ${saved.length}: ${saved.join(", ")}`);
  if (skipped.length > 0) parts.push(`skipped ${skipped.length} (already exist): ${skipped.join(", ")}`);
  if (blocked.length > 0) parts.push(`blocked ${blocked.length}: ${blocked.join(", ")}`);
  if (failed.length > 0) parts.push(`failed ${failed.length}: ${failed.join(", ")}`);
  return `${head}\n\n[Auto-promoted to long-term memory — ${parts.join("; ")}]`;
}

/**
 * I-5:把 ExtractedFact 列表写入 long-term memory。
 *
 * 行为:
 *   - 每条独立处理(失败不影响下一条)
 *   - MemoryPromote hook 可 block:该条标记 status=blocked + reason
 *   - writeMemory 异常:status=failed + reason
 *   - 成功:status=saved,trust=auto + source=compact-promote
 */
async function promoteFactsToMemory(
  facts: ExtractedFact[],
  cwd: string,
  hooks: HooksConfig | undefined,
  dedup: boolean,
): Promise<PromotedFact[]> {
  const results: PromotedFact[] = [];
  for (const fact of facts) {
    // O4 dedup:同名 memory 已存在(任一 scope)→ 跳过,不覆盖。
    // 防 LLM 反复提取同名 slug(如 user-prefers-typescript)把 verified 打回 auto。
    // 用户若想更新,走 /memory edit 显式改。dedup=false 时关闭此检查。
    if (dedup &&
        (existsSync(memoryFilePath(cwd, fact.name, "project")) ||
         existsSync(memoryFilePath(cwd, fact.name, "user")))) {
      results.push({
        name: fact.name,
        type: fact.type,
        description: fact.description,
        status: "skipped",
        reason: "already exists; not overwriting (use /memory edit to update)",
      });
      continue;
    }
    try {
      await runHooks(
        "MemoryPromote",
        { name: fact.name, type: fact.type, description: fact.description, body: fact.body, source: "compact-promote" },
        hooks,
      );
    } catch (err) {
      if (err instanceof PipelineBlockedError) {
        results.push({
          name: fact.name,
          type: fact.type,
          description: fact.description,
          status: "blocked",
          reason: err.reason,
        });
        continue;
      }
      results.push({
        name: fact.name,
        type: fact.type,
        description: fact.description,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    try {
      await writeMemory(cwd, {
        name: fact.name,
        description: fact.description,
        type: fact.type,
        body: fact.body,
        trust: "auto",
        source: "compact-promote",
      });
      results.push({ name: fact.name, type: fact.type, description: fact.description, status: "saved" });
    } catch (err) {
      results.push({
        name: fact.name,
        type: fact.type,
        description: fact.description,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
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
  schema: SummarySchema,
  abortSignal?: AbortSignal,
  onProgress?: (chars: number) => void,
): Promise<string> {
  const transcript = renderTranscript(older);
  const prompt: Message[] = [
    {
      role: "user",
      content: buildSummaryPrompt(transcript, schema),
    },
  ];

  let text = "";
  for await (const ev of llm.stream({ messages: prompt, abortSignal })) {
    if (ev.type === "text") {
      text += ev.delta;
      onProgress?.(text.length);
    } else if (ev.type === "error") throw ev.error;
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
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text") out.push(p.text);
    else if (p.type === "file") out.push(`[file: ${p.path}]`);
    else if (p.type === "image") out.push(`[image: ${p.path ?? p.mediaType}]`);
  }
  return out.join("\n");
}
