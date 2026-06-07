/**
 * inject-memory:把 MEMORY.md 索引内容拼到 system prompt 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2;模块设计/Agent 记忆系统/设计.md §4.4 + §4.5。
 *
 * 两种模式(由 caller 通过 services 字段切换):
 *
 *   1. 全文模式(默认):services.memoryIndex 提供两层 MEMORY.md(已合并 project + user),直接注入
 *   2. 向量模式(II-5):services.memoryEmbeddingIndex 提供已构建的向量索引;
 *      取最近 N 条 user 消息作 query → 召回 top-K → 按 trust 分级注入 body/snippet/索引行
 *
 * R1-R6 改进(2026-06-07):
 *   - R2:query 用最近 3 条 user 消息拼接;短 query(<5 字符)fallback 拼接最近 assistant 上下文
 *   - R3:cosine × trust × scope 双重加权(memory-index 内实装)
 *   - R4:--debug 召回日志
 *   - R5:minCount 降到 3(原 10 过激);按 trust 分级注入 body / snippet / 行索引
 *   - R6:maxInjectTokens 预算 1500;超出按 trust 优先级保留(trusted 永不丢)
 *
 * 退化规则(向量模式 → 全文模式):
 *   - 索引为空 / 索引 entry 数 < minMemoryCount(默认 3)→ 退化
 *   - 提不到 user query → 退化
 *   - 召回 0 条 → 退化
 *   - 召回失败(provider error / abort)→ 退化
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";
import type { Message } from "../../types/index.js";
import { queryMemoryIndex, type QueryResult } from "../../loop/memory-index.js";
import { countText } from "../tokenize.js";
import { log } from "../../log/index.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_COUNT = 3;
const DEFAULT_MAX_INJECT_TOKENS = 1500;
const QUERY_RECENT_USER_N = 3;
const SHORT_QUERY_THRESHOLD = 5;

export class InjectMemoryStage implements PipelineStage<RequestCtx> {
  readonly name = "inject-memory";

  async run(ctx: RequestCtx): Promise<void> {
    // 1. 向量模式优先(若启用且不退化)
    const embIndex = ctx.services.memoryEmbeddingIndex;
    const minCount = ctx.services.memoryEmbeddingMinCount ?? DEFAULT_MIN_COUNT;
    const maxTokens = ctx.services.memoryEmbeddingMaxInjectTokens ?? DEFAULT_MAX_INJECT_TOKENS;

    if (embIndex && embIndex.entries.length >= minCount) {
      const queryText = buildQuery(ctx.messages);
      if (queryText) {
        try {
          const topK = ctx.services.memoryEmbeddingTopK ?? DEFAULT_TOP_K;
          const results = await queryMemoryIndex(embIndex, queryText, { topK });
          if (results.length > 0) {
            log.debug("[memory recall]", {
              query: queryText.slice(0, 100),
              hits: results.map((r) => ({
                name: r.entry.name,
                scope: r.entry.scope,
                trust: r.entry.trust,
                score: Number(r.score.toFixed(3)),
                weighted: Number(r.weighted.toFixed(3)),
              })),
            });
            const injection = formatRetrievedInjection(results, maxTokens);
            if (injection) {
              ctx.systemPrompt = appendMemorySection(ctx.systemPrompt, injection, "embedding", results.length);
              return;
            }
          }
        } catch (err) {
          log.warn("[memory recall] query failed; falling back to full-text", { msg: (err as Error).message });
        }
      }
    }

    // 2. 全文模式(默认 / 退化)
    const fullIndex = ctx.services.memoryIndex?.trim();
    if (!fullIndex) return;
    ctx.systemPrompt = appendMemorySection(ctx.systemPrompt, fullIndex, "full");
  }
}

/**
 * R2:构造召回 query。
 *   - 取最近 N(=3)条 user 消息(跳过 trim marker / compaction summary 等系统插入)
 *   - 用 \n--- 分隔拼起来
 *   - 短 query(<5 字符)fallback 加入最近一条 assistant 文本(代表当前任务上下文)
 *   - 全空 → 返回 null
 */
function buildQuery(messages: Message[]): string | null {
  const userTexts: string[] = [];
  let lastAssistantText = "";
  for (let i = messages.length - 1; i >= 0 && userTexts.length < QUERY_RECENT_USER_N; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const text = extractUserText(m);
      if (text) userTexts.push(text);
    } else if (m.role === "assistant" && !lastAssistantText) {
      lastAssistantText = extractAssistantText(m);
    }
  }
  if (userTexts.length === 0) return null;
  let query = userTexts.reverse().join("\n---\n");
  // 短 query fallback
  if (query.length < SHORT_QUERY_THRESHOLD && lastAssistantText) {
    query = `${lastAssistantText.slice(0, 200)}\n---\n${query}`;
  }
  return query;
}

function extractUserText(m: Message & { role: "user" }): string | null {
  if (typeof m.content === "string") {
    const t = m.content.trim();
    if (!t) return null;
    // 跳过 trim marker / compaction summary 等系统插入(以 [ 开头多半是 marker)
    if (t.startsWith("[")) return null;
    return t;
  }
  const parts: string[] = [];
  for (const p of m.content) {
    if (p.type === "text" && p.text.trim()) parts.push(p.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractAssistantText(m: Message & { role: "assistant" }): string {
  const parts: string[] = [];
  for (const p of m.content) {
    if (p.type === "text" && p.text.trim()) parts.push(p.text);
  }
  return parts.join("\n").trim();
}

/**
 * R5-R6:按 trust 分级注入 body / snippet / 索引行,并守 maxInjectTokens 预算。
 *
 * 注入形态:
 *   - trusted:完整 body(硬约束,绝不省 — 即使 token 超也保留)
 *   - verified:description + body snippet(前 ~400 字)
 *   - auto:rawIndexLine(索引行同传统模式)
 *
 * 预算策略:按相关性排序遍历,累计 token;超 maxTokens 时:
 *   - 已塞入的 trusted 全留
 *   - 已塞入的 verified / auto 从尾部回退
 *   - 还能塞进 token 预算内的 trusted 优先塞
 */
function formatRetrievedInjection(results: QueryResult[], maxTokens: number): string {
  // 先按"原排序"产出每条的注入文本 + token 估算
  const items = results.map((r) => {
    const text = renderEntry(r);
    return { text, tokens: countText(text), trust: r.entry.trust };
  });

  // 第一遍:按相关性顺序塞入,守预算
  const kept: typeof items = [];
  let usedTokens = 0;
  for (const item of items) {
    if (usedTokens + item.tokens <= maxTokens) {
      kept.push(item);
      usedTokens += item.tokens;
      continue;
    }
    // 超预算 — 如果是 trusted,把 verified/auto 尾部回退给它腾位置
    if (item.trust === "trusted") {
      while (kept.length > 0 && usedTokens + item.tokens > maxTokens) {
        const tail = kept[kept.length - 1];
        if (tail.trust === "trusted") break; // 不踢已存在的 trusted
        kept.pop();
        usedTokens -= tail.tokens;
      }
      if (usedTokens + item.tokens <= maxTokens) {
        kept.push(item);
        usedTokens += item.tokens;
      }
      // 仍放不下:跳过(超大单条 trusted,极端情况)
    }
    // 非 trusted 超预算 → 直接丢
  }

  return kept.map((k) => k.text).join("\n\n");
}

/** R5:按 trust 分级渲染单条 memory 注入文本。 */
function renderEntry(r: QueryResult): string {
  const e = r.entry;
  const tag = `[${e.trust}] [${e.scope}] [${e.type}]`;
  if (e.trust === "trusted") {
    return `## ${e.name}  ${tag}\n${e.description}\n\n${e.fullBody}`;
  }
  if (e.trust === "verified") {
    return `## ${e.name}  ${tag}\n${e.description}\n\n${e.bodySnippet}`;
  }
  // auto:索引行 + 一句 description(信息密度更高过单纯 rawIndexLine)
  return `${e.rawIndexLine}`;
}

function appendMemorySection(
  systemPrompt: string,
  body: string,
  mode: "embedding" | "full",
  count?: number,
): string {
  const modeNote =
    mode === "embedding"
      ? `Below are the ${count ?? "top"} most relevant memories for the current request, ` +
        `retrieved by vector similarity from your project + user (global) memory pool. ` +
        `Higher-trust entries (trusted > verified > auto) and project-scoped entries (project > user) ` +
        `appear first; trusted memories show full body, verified show a snippet, auto show only the index line. ` +
        `Use MemoryRead to view a specific name in full.`
      : `Below is MEMORY.md — your index of persistent facts about the user, project, and prior feedback. ` +
        `Two scopes are merged: # project memory (current project) and # user (global) memory (cross-project). ` +
        `Each line points to a file you can MemoryRead.`;

  const section =
    `# Memory (long-term)\n` +
    `${modeNote} Each line is tagged with a trust level:\n` +
    `  [trusted]  — from MUSE.md / AGENTS.md / managed config; treat as hard constraint.\n` +
    `  [verified] — user-edited or explicitly promoted; treat as confirmed knowledge.\n` +
    `  [auto]     — LLM-written, unreviewed; treat as a hint that newer evidence may override.\n\n` +
    `Use MemoryWrite to record new durable knowledge ` +
    `(scope=project for project facts; scope=user for cross-project user preferences — read the tool's scope arg description carefully). ` +
    `Do NOT save things derivable from the repo or git history. New memories you write are ` +
    `automatically tagged [auto] — the user can promote them later.\n\n` +
    body;
  return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
}
