/**
 * Local embedding provider 基于 `@huggingface/transformers`(原 Xenova/transformers)。
 *
 * 部署要求(用户启用 local-* preset 时手动安装):
 *   npm i -g @huggingface/transformers   # 或在项目内 npm i @huggingface/transformers
 *
 * 行为:
 *   - lazy 加载模型(首次 embed 时):走 ONNX runtime 跨平台跑
 *   - 模型缓存到 ~/.cache/huggingface/hub/(transformers 自管)
 *   - 实例级单例 pipeline:同 provider 实例多次 embed 复用 pipeline,不重复加载
 *   - 错误处理:模块未装 → 抛清晰错(含 npm i 命令);其他错误抛原始消息
 *
 * macOS 测试 OK 后,其他平台(Linux x86 / Linux ARM / Windows)需另测 ONNX runtime 兼容性。
 *
 * 当前推荐模型(参考 Xenova 命名空间 ONNX 转换版):
 *   - Xenova/bge-small-zh-v1.5     512-dim 中文优化
 *   - Xenova/bge-small-en-v1.5     384-dim 英文优化
 *   - Xenova/all-MiniLM-L6-v2      384-dim 通用多语言
 *   - Xenova/bge-m3                1024-dim 多语言强项
 */

import type { EmbeddingProvider } from "./types.js";

export interface LocalTransformersConfig {
  /** HuggingFace 模型 ID(必填;通常 Xenova/... 命名空间的 ONNX 版本)。 */
  model: string;
  /** 维度(用户根据模型官方说明 / preset 默认填)。 */
  dim: number;
}

/**
 * 全局 pipeline 缓存:同模型在 muse 整个进程内只加载一次。
 * key = model name;value = pipeline 函数(`@huggingface/transformers` 的 feature-extraction pipeline)。
 */
const PIPELINE_CACHE = new Map<string, unknown>();

/** 标记 import 失败时缓存 — 避免每次 embed 都重试导入(失败一次就稳定降级)。 */
let importFailed = false;
let cachedImportError: string | undefined;

export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  constructor(private readonly config: LocalTransformersConfig) {
    this.dim = config.dim;
    this.id = `local-transformers:${config.model}:${config.dim}`;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    // pipe(text, { pooling: "mean", normalize: true }) → output.data 是 Float32Array
    const output = await (pipe as (text: string, opts: object) => Promise<{ data: Float32Array | number[] }>)(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // transformers.js 的 pipeline 支持 batch input,但内部仍是串行处理(单 ONNX session)
    // 为简洁与可重入,本期直接 for 串行;后续可优化
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await this.embed(text));
    }
    return out;
  }

  private async getPipeline(): Promise<unknown> {
    const cached = PIPELINE_CACHE.get(this.config.model);
    if (cached) return cached;

    if (importFailed) {
      throw new Error(
        cachedImportError ??
          `@huggingface/transformers not installed. Run: npm i -g @huggingface/transformers`,
      );
    }

    let transformers: { pipeline: (task: string, model: string) => Promise<unknown> };
    try {
      // 动态 import — 未装时抛 ERR_MODULE_NOT_FOUND
      transformers = (await import(
        /* @vite-ignore */ "@huggingface/transformers" as string
      )) as { pipeline: (task: string, model: string) => Promise<unknown> };
    } catch (err) {
      importFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      // 友好提示
      if (msg.includes("Cannot find module") || msg.includes("ERR_MODULE_NOT_FOUND") || msg.includes("not installed")) {
        cachedImportError =
          `Provider local-* requires @huggingface/transformers. Run:\n` +
          `  npm i -g @huggingface/transformers\n` +
          `(first-run will download the ONNX model ~24MB to ~/.cache/huggingface/hub/)`;
      } else {
        cachedImportError = `Failed to load @huggingface/transformers: ${msg}`;
      }
      throw new Error(cachedImportError);
    }

    if (typeof transformers.pipeline !== "function") {
      throw new Error(`@huggingface/transformers loaded but pipeline export is missing`);
    }

    const pipe = await transformers.pipeline("feature-extraction", this.config.model);
    PIPELINE_CACHE.set(this.config.model, pipe);
    return pipe;
  }
}

/** 测试用:清缓存 + 重置 import 失败状态。 */
export function _resetLocalTransformersCache(): void {
  PIPELINE_CACHE.clear();
  importFailed = false;
  cachedImportError = undefined;
}
