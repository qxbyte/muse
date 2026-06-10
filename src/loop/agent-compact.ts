/**
 * Agent compact 闭包工厂。
 *
 * 从 src/loop/agent.ts 中抽出 — budget-guard 触发的 compact 流程涉及 LLM 调用、
 * messages 改写、facts → memory promote、向量索引 upsert,不是 agent 主循环的核心
 * 关注点;隔离到此文件让 agent.ts 不超 800 行硬上限(CLAUDE.md 模块化规则)。
 *
 * 设计文档:模块设计/上下文管理工程/设计.md §4.5(I-5 compact → memory 联动)。
 */

import type { LLMClient } from "../llm/types.js";
import type { Message } from "../types/index.js";
import type { HooksConfig } from "../preprocess/hooks.js";
import type { MemoryIndex } from "./memory-index.js";
import { compactMessages } from "./context.js";
import { upsertMemoryEntry } from "./memory-index.js";
import { log } from "../log/index.js";

export interface CompactClosureDeps {
  llm: LLMClient;
  hooks?: HooksConfig;
  cwd: string;
  memoryEmbeddingIndex?: MemoryIndex;
  /** Agent 用 closure 拿到当前 messages(每次调用现读,因为 messages 在 tool 执行间会变)。 */
  getMessages: () => Message[];
  /** Compact 后真实改写 agent.messages 的 setter(单一真值)。 */
  setMessages: (msgs: Message[]) => void;
  /** I-2 摘要 schema(默认 "9-section")。 */
  schema?: "9-section" | "6-section";
  /** O3:9-section 失败时降级 6-section 重试(默认 true)。 */
  fallbackOnFormatFail?: boolean;
  /** O4:source=compact-promote 写入前检查同名 memory 是否已存在(默认 true,跳过不覆盖)。 */
  dedupPromotedFacts?: boolean;
  /** I-5:自动 compact 是否 promote facts 到 memory(默认 true)。 */
  promoteFactsToMemory?: boolean;
}

/**
 * 工厂函数:返回 `(signal?) => Promise<Message[]>`,与 RequestServices.compact 签名一致。
 * 内部:跑 compactMessages → 改写 messages → 把成功 promote 的 facts upsert 到内存向量索引。
 */
export function makeCompactClosure(deps: CompactClosureDeps) {
  return async (signal?: AbortSignal): Promise<Message[]> => {
    // I-5 联动:传 cwd 触发 facts 自动 promote 到 long-term memory
    // settings 子开关(schema / fallback / dedup / promote)透传到 compactMessages
    const result = await compactMessages(deps.getMessages(), {
      llm: deps.llm,
      abortSignal: signal,
      hooks: deps.hooks,
      cwd: deps.cwd,
      schema: deps.schema,
      fallbackOnFormatFail: deps.fallbackOnFormatFail,
      dedupPromotedFacts: deps.dedupPromotedFacts,
      promoteFactsToMemory: deps.promoteFactsToMemory,
    });
    deps.setMessages(result.newMessages);
    // II-5 联动:成功 promote 的 facts upsert 到 in-memory 向量索引(session 内立即可召回)
    if (result.promotedFacts && deps.memoryEmbeddingIndex) {
      await upsertPromotedFacts(deps.memoryEmbeddingIndex, result.promotedFacts);
    }
    return deps.getMessages();
  };
}

async function upsertPromotedFacts(
  index: MemoryIndex,
  facts: { name: string; status: string }[],
): Promise<void> {
  for (const f of facts) {
    if (f.status !== "saved") continue;
    try {
      await upsertMemoryEntry(index, f.name, "project");
    } catch (err) {
      log.warn("memory index upsert (compact-promote) failed", {
        name: f.name,
        msg: (err as Error).message,
      });
    }
  }
}
