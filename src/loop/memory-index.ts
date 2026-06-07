/**
 * Memory 向量索引(II-5)。
 *
 * 设计文档:模块设计/Agent 记忆系统/设计.md §4.5。
 *
 * 本期实装:**in-memory** 索引(每轮起重新建,memory 数量小时开销低)。
 * 后续(LanceDB 引入后):落盘 `~/.muse/projects/<hash>/memory/.lance/`,增量更新。
 *
 * 数据结构:
 *   { name, type, trust, segment, raw, vector }
 *
 * 召回:
 *   - query → embed → 余弦相似度 + trust 加权(trusted ×1.5,verified ×1.2,auto ×1.0)
 *   - 取 top-K
 *   - 输出格式同 loadMemoryIndex,但只含召回的几条,缩短注入长度
 *
 * 冷启动保护:memoryCount < minMemoryCount(默认 10)→ 退化到全注入模式
 *   (传统 loadMemoryIndex)。理由:几条 memory 全注入更可靠,向量召回反而易丢。
 */

import { listMemories, type MemoryFile, trustRank, type TrustLevel } from "./memory.js";
import { createEmbeddingProvider, cosineSimilarity, type EmbeddingProvider, type EmbeddingConfig } from "./embedding/index.js";

export interface MemoryIndexEntry {
  name: string;
  type: MemoryFile["frontmatter"]["type"];
  trust: TrustLevel;
  description: string;
  /** 用于注入 prompt 的"行格式"片段:`[trust] - [name](name.md) — description`。 */
  rawIndexLine: string;
  /** 完整 frontmatter + body(给召回结果详情展示用)。 */
  bodySnippet: string;
  vector: number[];
}

export interface MemoryIndex {
  provider: EmbeddingProvider;
  entries: MemoryIndexEntry[];
  /** 索引构建时刻 ISO。 */
  builtAt: string;
}

export interface BuildIndexOpts {
  config?: EmbeddingConfig;
  /** 自定义 provider(测试用);提供时覆盖 config。 */
  provider?: EmbeddingProvider;
}

/** 从 cwd 下所有 memory 文件构建 in-memory 向量索引。 */
export async function buildMemoryIndex(cwd: string, opts: BuildIndexOpts = {}): Promise<MemoryIndex> {
  const provider = opts.provider ?? createEmbeddingProvider(opts.config);
  const files = await listMemories(cwd);
  const entries: MemoryIndexEntry[] = [];
  for (const f of files) {
    const fm = f.frontmatter;
    // 用 description + body 作为 embed 输入(name 也可能有信息但 description 已含)
    const text = `${fm.description}\n\n${f.body}`;
    const vector = await provider.embed(text);
    entries.push({
      name: fm.name,
      type: fm.type,
      trust: fm.trust,
      description: fm.description,
      rawIndexLine: `[${fm.trust}] - [${fm.name}](${fm.name}.md) — ${fm.description}`,
      bodySnippet: f.body.length > 400 ? f.body.slice(0, 400) + "\n... [truncated]" : f.body,
      vector,
    });
  }
  return { provider, entries, builtAt: new Date().toISOString() };
}

export interface QueryOpts {
  /** top-K(默认 5)。 */
  topK?: number;
  /** 最低相似度阈值(默认 0;降低阈值召回更多但噪音多)。 */
  minScore?: number;
}

export interface QueryResult {
  entry: MemoryIndexEntry;
  /** 余弦相似度。 */
  score: number;
  /** trust 加权后的最终排序分。 */
  weighted: number;
}

/** 召回:embed query → 余弦相似度 × trust 加权 → top-K。 */
export async function queryMemoryIndex(
  index: MemoryIndex,
  queryText: string,
  opts: QueryOpts = {},
): Promise<QueryResult[]> {
  if (index.entries.length === 0) return [];
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  const queryVec = await index.provider.embed(queryText);
  const scored = index.entries
    .map((entry) => {
      const score = cosineSimilarity(queryVec, entry.vector);
      const weighted = score * trustWeight(entry.trust);
      return { entry, score, weighted };
    })
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.weighted - a.weighted);
  return scored.slice(0, topK);
}

/** trust 加权:trusted ×1.5,verified ×1.2,auto ×1.0(对齐设计 §4.5)。 */
function trustWeight(t: TrustLevel): number {
  switch (t) {
    case "trusted":
      return 1.5;
    case "verified":
      return 1.2;
    case "auto":
      return 1.0;
  }
}

/** 把召回结果格式化为可注入 system prompt 的索引段(替代 loadMemoryIndex)。 */
export function formatRetrievedAsIndex(results: QueryResult[]): string {
  if (results.length === 0) return "";
  return results.map((r) => r.entry.rawIndexLine).join("\n");
}

export { trustRank, trustWeight };
