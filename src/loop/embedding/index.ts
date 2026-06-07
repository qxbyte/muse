/**
 * Embedding Provider factory + 配置解析 + probe 校验。
 *
 * 配置层级(用户视角):
 *   - settings.memory.embedding.enabled=false(默认)→ 走 hash-bag(零依赖)
 *   - enabled=true + preset="..." → 用 preset 默认,用户可覆盖 model/dim
 *   - enabled=true + provider="openai-compatible" + 手填 baseUrl/model/dim/apiKey → 完全自定义
 *
 * preset / provider / modelId 三选一(modelId 路径在 cli/app 解析时翻译成 provider 参数)。
 *
 * probe 行为(createAndProbeProvider):
 *   - 创建 provider 后发一个 embed("muse-embedding-test") 探针
 *   - 校验返回向量长度 === provider.dim
 *   - 不一致 → 抛 EmbeddingDimMismatchError(caller 降级 + 提示用户修正)
 *   - hash-bag 不做 probe(代码内决定,稳定)
 */

import type { EmbeddingConfig, EmbeddingProvider } from "./types.js";
import { HashBagEmbeddingProvider } from "./hash-bag.js";
import { OpenAICompatibleEmbeddingProvider } from "./openai-compatible.js";
import { getPreset, listPresetNames, EMBEDDING_PRESETS, type EmbeddingPreset } from "./presets.js";

export * from "./types.js";
export { HashBagEmbeddingProvider, tokenize, cosineSimilarity } from "./hash-bag.js";
export { OpenAICompatibleEmbeddingProvider } from "./openai-compatible.js";
export { EMBEDDING_PRESETS, getPreset, listPresetNames, type EmbeddingPreset } from "./presets.js";

/** preset/provider 默认维度跟实际返回维度不匹配。 */
export class EmbeddingDimMismatchError extends Error {
  constructor(
    public readonly configured: number,
    public readonly actual: number,
    public readonly model: string,
  ) {
    super(
      `Embedding dimension mismatch: configured=${configured} but model returned ${actual} ` +
        `(model: ${model}). Fix by setting settings.memory.embedding.dim to ${actual}.`,
    );
    this.name = "EmbeddingDimMismatchError";
  }
}

/** 扩展的 embedding 配置(对 settings 解析后的标准化形态)。 */
export interface ExtendedEmbeddingConfig extends EmbeddingConfig {
  preset?: string;
  baseUrl?: string;
  dim?: number;
}

/**
 * 创建 provider(不做 probe)。
 * probe 由 createAndProbeProvider 包装,cli/app 启动期使用 probe 版本。
 */
export function createEmbeddingProvider(config: ExtendedEmbeddingConfig = {}): EmbeddingProvider {
  // 默认 / 显式 hash-bag(零依赖)
  if (!config.provider && !config.preset) {
    return new HashBagEmbeddingProvider();
  }
  if (config.provider === "hash-bag") {
    return new HashBagEmbeddingProvider();
  }

  // preset 解析(填默认值)
  let baseUrl = config.baseUrl;
  let model = config.model;
  let dim = config.dim;
  let preset: EmbeddingPreset | null = null;

  if (config.preset) {
    preset = getPreset(config.preset);
    if (!preset) {
      throw new Error(
        `Unknown embedding preset "${config.preset}". Available: ${listPresetNames().join(", ")}`,
      );
    }
    baseUrl ??= preset.baseUrl;
    model ??= preset.model;
    dim ??= preset.dim;
  }

  // openai-compatible(显式 / 通过 preset)
  if (config.provider === "openai-compatible" || config.preset) {
    if (!baseUrl) throw new Error(`embedding config missing baseUrl (set via preset or explicitly)`);
    if (!model) throw new Error(`embedding config missing model`);
    if (!dim) throw new Error(`embedding config missing dim`);

    // apiKey 必填校验(preset 标了 requiresKey 的)
    if (preset && preset.requiresKey && !config.apiKey) {
      throw new Error(
        `preset "${config.preset}" requires apiKey. ` +
          `Set settings.memory.embedding.apiKey (\${ENV_VAR} supported, e.g. \${DASHSCOPE_API_KEY}).`,
      );
    }

    return new OpenAICompatibleEmbeddingProvider({
      baseUrl,
      model,
      apiKey: config.apiKey,
      dim,
      // 用户显式覆盖 dim 时,HTTP 请求带 dimensions 参数(MRL truncation)
      sendDimensions: config.dim !== undefined,
    });
  }

  // 兼容旧 provider 名
  if (config.provider === "openai") {
    const p = EMBEDDING_PRESETS["openai-3-small"];
    if (!config.apiKey) throw new Error(`provider "openai" requires apiKey`);
    return new OpenAICompatibleEmbeddingProvider({
      baseUrl: p.baseUrl,
      model: config.model ?? p.model,
      apiKey: config.apiKey,
      dim: config.dim ?? p.dim,
      sendDimensions: config.dim !== undefined,
    });
  }

  if (config.provider === "local-minilm") {
    throw new Error(
      `Provider "local-minilm" requires @huggingface/transformers (not yet supported in this version). ` +
        `Use preset "ollama-nomic" / "ollama-bge-m3" for local, or preset "dashscope-v3" / "openai-3-small" for cloud.`,
    );
  }

  throw new Error(`Unknown embedding provider: ${config.provider}`);
}

/**
 * createAndProbeProvider:创建 provider + 探针校验 dim。
 *
 * - hash-bag 不 probe(稳定,无 HTTP)
 * - 其他 provider:发 embed("muse-embedding-test") 一次,校验向量长度
 * - 不一致 → 抛 EmbeddingDimMismatchError
 * - 网络 / 401 等其他失败 → 抛原始错误(包含 baseUrl + status,便于用户定位)
 *
 * cli/app 在启动期 catch 任何错误 → 降级 hash-bag(完全不阻塞 muse 启动)。
 */
export async function createAndProbeProvider(config: ExtendedEmbeddingConfig): Promise<EmbeddingProvider> {
  const provider = createEmbeddingProvider(config);
  if (provider.id.startsWith("hash-bag")) return provider;

  const probe = await provider.embed("muse-embedding-test");
  if (probe.length !== provider.dim) {
    throw new EmbeddingDimMismatchError(provider.dim, probe.length, config.model ?? "(unknown)");
  }
  return provider;
}
