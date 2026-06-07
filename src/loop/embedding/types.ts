/**
 * Embedding Provider 抽象。
 *
 * 设计文档:模块设计/Agent 记忆系统/设计.md §4.5 + §五.5.3。
 *
 * 本期实装 hash-bag 本地 provider(零依赖,跨平台无 native binding 风险)。
 * 真 LanceDB(@lancedb/lancedb)+ 真 embedding(@xenova/transformers MiniLM-L6-v2
 * 或 OpenAI text-embedding-3-small)通过同接口扩展,留下批引入 peerDeps。
 */

export interface EmbeddingProvider {
  /** 模型 / 后端标识(用于索引 invalidate;切 provider 时整库重建)。 */
  readonly id: string;
  /** 向量维度。 */
  readonly dim: number;
  /** 文本 → 向量(已 L2 归一化)。 */
  embed(text: string): Promise<number[]>;
  /** 批量 embed(默认串行;实装可优化为批 API)。 */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderKind = "hash-bag" | "openai-compatible" | "openai" | "local-minilm";

export interface EmbeddingConfig {
  /** 默认 hash-bag(零依赖)。 */
  provider?: EmbeddingProviderKind;
  /** 模型名(用户覆盖 preset 默认或自定义 provider 时填)。 */
  model?: string;
  /** API key(${ENV_VAR} 或明文;Ollama 等本地端点可省)。 */
  apiKey?: string;
}
