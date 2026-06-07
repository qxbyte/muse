/**
 * inject-memory:把 MEMORY.md 索引内容拼到 system prompt 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2;模块设计/Agent 记忆系统/设计.md §4.4 + §4.5。
 *
 * 两种模式(由 caller 通过 services 字段切换):
 *
 *   1. 全文模式(默认):services.memoryIndex 提供 MEMORY.md 前 200 行,直接注入
 *   2. 向量模式(II-5):services.memoryEmbeddingIndex 提供已构建的向量索引;
 *      从 ctx.messages 提取最新 user query → 召回 top-K → 注入精简索引
 *
 * 退化规则(向量模式 → 全文模式):
 *   - 索引为空 / 索引 entry 数 < minMemoryCount(默认 10)→ 退化
 *   - 提不到 user query → 退化
 *   - 召回 0 条 → 退化
 *   - 召回失败(provider error / abort)→ 退化
 *
 * 行为:索引行格式 `[trust] - [name](name.md) — description`(II-4 引入)。
 * 注入时附带 trust 含义说明,让 LLM 按等级权重信息。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";
import type { Message } from "../../types/index.js";
import { queryMemoryIndex, formatRetrievedAsIndex } from "../../loop/memory-index.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_COUNT = 10;

export class InjectMemoryStage implements PipelineStage<RequestCtx> {
  readonly name = "inject-memory";

  async run(ctx: RequestCtx): Promise<void> {
    let indexText: string | undefined;
    let mode: "embedding" | "full" = "full";

    // 1. 向量模式优先(若启用且不退化)
    const embIndex = ctx.services.memoryEmbeddingIndex;
    const minCount = ctx.services.memoryEmbeddingMinCount ?? DEFAULT_MIN_COUNT;
    if (embIndex && embIndex.entries.length >= minCount) {
      const queryText = extractLatestUserText(ctx.messages);
      if (queryText) {
        try {
          const topK = ctx.services.memoryEmbeddingTopK ?? DEFAULT_TOP_K;
          const results = await queryMemoryIndex(embIndex, queryText, { topK });
          if (results.length > 0) {
            indexText = formatRetrievedAsIndex(results);
            mode = "embedding";
          }
        } catch {
          // 召回失败 → 退化到全文模式
        }
      }
    }

    // 2. 全文模式(默认 / 退化)
    if (!indexText) {
      indexText = ctx.services.memoryIndex?.trim();
    }

    if (!indexText) return;

    const modeNote =
      mode === "embedding"
        ? `Below are the ${ctx.services.memoryEmbeddingTopK ?? DEFAULT_TOP_K} most relevant memories for the current request ` +
          `(retrieved by vector similarity from a larger pool). Use MemoryRead to look up a specific name; ` +
          `if you need broader context, ask the user to disable embedding via settings.`
        : `Below is MEMORY.md — your index of persistent facts about the user, project, and prior feedback. ` +
          `Each line points to a file you can MemoryRead.`;

    const section =
      `# Memory (long-term)\n` +
      `${modeNote} Each line is tagged with a trust level:\n` +
      `  [trusted]  — from MUSE.md / AGENTS.md / managed config; treat as hard constraint.\n` +
      `  [verified] — user-edited or explicitly promoted; treat as confirmed knowledge.\n` +
      `  [auto]     — LLM-written, unreviewed; treat as a hint that newer evidence may override.\n\n` +
      `Use MemoryWrite to record new durable knowledge ` +
      `(user role/preferences, validated decisions, project facts, external references). ` +
      `Do NOT save things derivable from the repo or git history. New memories you write are ` +
      `automatically tagged [auto] — the user can promote them later.\n\n` +
      indexText;
    ctx.systemPrompt = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${section}`
      : section;
  }
}

/**
 * 从 messages 中取"最新的 user message 文本"作为召回 query。
 * 多模态 user message 只取 text part;无文本时跳过。
 */
function extractLatestUserText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      const t = m.content.trim();
      // 跳过 trim marker / compaction summary 等非真用户内容(以 [ 开头多半是系统插入)
      if (t.startsWith("[") || t.startsWith("[Previous conversation summary]")) continue;
      if (t) return t;
      continue;
    }
    // 多模态:拼所有 text part
    const parts: string[] = [];
    for (const p of m.content) {
      if (p.type === "text" && p.text.trim()) parts.push(p.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}
