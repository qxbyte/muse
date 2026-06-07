/**
 * Embedding Provider factory。
 *
 * 设计 §4.5:本期默认 hash-bag(零依赖);local-minilm / openai 留下批引入。
 */

import type { EmbeddingConfig, EmbeddingProvider } from "./types.js";
import { HashBagEmbeddingProvider } from "./hash-bag.js";

export * from "./types.js";
export { HashBagEmbeddingProvider, tokenize, cosineSimilarity } from "./hash-bag.js";

export function createEmbeddingProvider(config: EmbeddingConfig = {}): EmbeddingProvider {
  const kind = config.provider ?? "hash-bag";
  switch (kind) {
    case "hash-bag":
      return new HashBagEmbeddingProvider();
    case "local-minilm":
      throw new Error(
        `Embedding provider "local-minilm" requires @xenova/transformers (not yet installed). ` +
          `Run \`npm i @xenova/transformers\` or set provider to "hash-bag" in settings.`,
      );
    case "openai":
      throw new Error(
        `Embedding provider "openai" requires HTTP integration (留下批引入). ` +
          `Use "hash-bag" for now.`,
      );
    default:
      throw new Error(`Unknown embedding provider: ${kind}`);
  }
}
