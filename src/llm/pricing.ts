/**
 * 模型单价表（USD per 1M tokens）。
 *
 * 设计文档：muse-design.md §11.2 Token / 费用统计。
 *
 * 数据来源：各 provider 公开价格页（2026 年初快照）。仅供 /cost 命令展示估算用，
 * 不保证准确性，价格变动用户可在 ~/.muse/settings.json 自定义覆盖（v0.2 起）。
 */

export interface ModelPricing {
  /** 输入 token 单价（USD per 1M）。 */
  inputPer1M: number;
  /** 输出 token 单价（USD per 1M）。 */
  outputPer1M: number;
}

const PRICING: Record<string, Record<string, ModelPricing>> = {
  openai: {
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30 },
  },
  deepseek: {
    "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
    "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  },
  qwen: {
    "qwen-plus": { inputPer1M: 0.4, outputPer1M: 1.2 },
    "qwen-max": { inputPer1M: 2.8, outputPer1M: 8.4 },
    "qwen-turbo": { inputPer1M: 0.05, outputPer1M: 0.2 },
  },
  moonshot: {
    "moonshot-v1-8k": { inputPer1M: 1.68, outputPer1M: 1.68 },
    "moonshot-v1-32k": { inputPer1M: 3.36, outputPer1M: 3.36 },
    "moonshot-v1-128k": { inputPer1M: 8.4, outputPer1M: 8.4 },
  },
  zhipu: {
    "glm-4-flash": { inputPer1M: 0, outputPer1M: 0 },
    "glm-4-plus": { inputPer1M: 7, outputPer1M: 7 },
  },
  ollama: {
    // 本地模型零成本
  },
};

export function lookupPricing(provider: string, model: string): ModelPricing | undefined {
  return PRICING[provider]?.[model];
}

export function estimateCostUSD(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const p = lookupPricing(provider, model);
  if (!p) return undefined;
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}

/** 把 USD 金额格式化成人类可读字符串。小于 1 美分用 micro-dollar 显示。 */
export function formatUSD(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `<$0.0001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(4)}`;
}
