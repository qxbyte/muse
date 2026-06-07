/**
 * OpenAI-compatible HTTP embedding provider(纯 fetch,无 npm 依赖)。
 *
 * 覆盖:
 *   - OpenAI(api.openai.com)
 *   - 阿里 DashScope(国内直连)
 *   - 智谱 BigModel(国内直连)
 *   - Ollama 本地(localhost,无需 apiKey)
 *   - 任何 OpenAI 协议的自托管端点(vLLM / TEI / 等)
 *
 * 协议:POST `{baseUrl}/embeddings`
 *   body: { model, input, dimensions? }
 *   response: { data: [{ embedding: number[] }, ...] }
 *
 * `dimensions` 参数(MRL truncation)只在 sendDimensions=true 时带 — 用户显式覆盖 dim 时启用。
 * preset 默认 dim 不带 dimensions,走模型默认维度。
 */

import type { EmbeddingProvider } from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  /** 可选;Ollama 等本地端点不需要。 */
  apiKey?: string;
  /** 必填(由 preset 默认 / 用户覆盖)。 */
  dim: number;
  /** 是否在 HTTP body 中带 dimensions 参数(MRL truncation)。默认 false。 */
  sendDimensions?: boolean;
  /** 默认 30000ms。 */
  timeoutMs?: number;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private readonly url: string;

  constructor(private config: OpenAICompatibleConfig) {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.url = `${baseUrl}/embeddings`;
    this.dim = config.dim;
    // id 包含 model 和 dim;切换模型 / 维度时索引会被自动 invalidate 重建
    this.id = `openai-compat:${config.model}:${config.dim}`;
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    return out[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: texts.length === 1 ? texts[0] : texts,
    };
    if (this.config.sendDimensions) {
      body.dimensions = this.dim;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const ctrl = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`embedding request timeout after ${timeoutMs}ms: ${this.url}`);
      }
      throw new Error(`embedding network error (${this.url}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `embedding HTTP ${res.status} ${res.statusText} (${this.url}): ${text.slice(0, 200) || "(no body)"}`,
      );
    }

    let data: { data?: Array<{ embedding?: unknown }> };
    try {
      data = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
    } catch (err) {
      throw new Error(`embedding response is not JSON (${this.url}): ${(err as Error).message}`);
    }

    if (!Array.isArray(data.data)) {
      throw new Error(`embedding response missing "data" array (${this.url})`);
    }

    const vectors: number[][] = [];
    for (const item of data.data) {
      if (!Array.isArray(item.embedding)) {
        throw new Error(`embedding response item missing "embedding" array (${this.url})`);
      }
      // 容错:确保每个元素是 number(部分 provider 可能返回 string)
      const vec = (item.embedding as unknown[]).map((v) => {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          throw new Error(`embedding contains non-numeric value (${this.url})`);
        }
        return n;
      });
      vectors.push(vec);
    }
    return vectors;
  }
}
