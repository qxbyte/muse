/**
 * Embedding preset 表 — 内置主流厂商的推荐配置(2026-06-07)。
 *
 * 设计:
 *   - preset 给"推荐默认"(baseUrl + model + dim + requiresKey)
 *   - 用户可通过 settings.memory.embedding.{model, dim, baseUrl} 覆盖任一字段
 *   - dim 是关键:用户根据模型官方说明可调,muse 启动期 probe 校验实际是否匹配
 *
 * 选 preset 的指导:
 *   - 国内用户 + 中文场景:dashscope-v3(便宜 + 直连)
 *   - 海外 + 跨语言强:openai-3-small / openai-3-large(需梯子)
 *   - 完全本地零成本:ollama-nomic / ollama-bge-m3(需先 ollama pull)
 *   - 完全自托管(vLLM / TEI):用 provider="openai-compatible" + 手填 baseUrl/model/dim/apiKey
 */

export interface EmbeddingPreset {
  baseUrl: string;
  model: string;
  /** 推荐默认维度;用户可通过 settings.dim 覆盖。 */
  dim: number;
  /** 是否必须 apiKey(本地端点为 false)。 */
  requiresKey: boolean;
  /** 显示用的人类可读描述(诊断输出 + 操作手册引用)。 */
  description: string;
}

export const EMBEDDING_PRESETS: Record<string, EmbeddingPreset> = {
  // === 国内直连 ===
  "dashscope-v3": {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    dim: 1024,
    requiresKey: true,
    description: "Alibaba DashScope text-embedding-v3 — 中文优化, MRL 降维支持(64/128/256/512/768/1024)",
  },
  "zhipu-3": {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "embedding-3",
    dim: 2048,
    requiresKey: true,
    description: "Zhipu BigModel embedding-3",
  },

  // === OpenAI(需梯子)===
  "openai-3-small": {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dim: 1536,
    requiresKey: true,
    description: "OpenAI text-embedding-3-small — MRL 降维支持(任意 ≤ 1536)",
  },
  "openai-3-large": {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-large",
    dim: 3072,
    requiresKey: true,
    description: "OpenAI text-embedding-3-large — MRL 降维支持(任意 ≤ 3072)",
  },

  // === Ollama 本地(零成本)===
  "ollama-nomic": {
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    dim: 768,
    requiresKey: false,
    description: "Ollama nomic-embed-text — 本地,先 `ollama pull nomic-embed-text`",
  },
  "ollama-bge-m3": {
    baseUrl: "http://localhost:11434/v1",
    model: "bge-m3",
    dim: 1024,
    requiresKey: false,
    description: "Ollama bge-m3 — 多语言本地,先 `ollama pull bge-m3`",
  },

  // === local-transformers(@huggingface/transformers,纯本地无 HTTP)===
  // baseUrl 字段不用,但保留以满足 EmbeddingPreset 类型;factory 通过 preset name 路由
  "local-bge-zh": {
    baseUrl: "",
    model: "Xenova/bge-small-zh-v1.5",
    dim: 512,
    requiresKey: false,
    description: "Local @huggingface/transformers bge-small-zh-v1.5 — 中文,先 `npm i -g @huggingface/transformers`",
  },
  "local-bge-en": {
    baseUrl: "",
    model: "Xenova/bge-small-en-v1.5",
    dim: 384,
    requiresKey: false,
    description: "Local @huggingface/transformers bge-small-en-v1.5 — 英文,先 `npm i -g @huggingface/transformers`",
  },
  "local-minilm": {
    baseUrl: "",
    model: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
    requiresKey: false,
    description: "Local @huggingface/transformers all-MiniLM-L6-v2 — 通用多语言,先 `npm i -g @huggingface/transformers`",
  },
  "local-bge-m3": {
    baseUrl: "",
    model: "Xenova/bge-m3",
    dim: 1024,
    requiresKey: false,
    description: "Local @huggingface/transformers bge-m3 — 多语言强项(大),先 `npm i -g @huggingface/transformers`",
  },
};

/** 是 local-transformers 类 preset(name 以 local- 开头)。 */
export function isLocalTransformersPreset(name: string): boolean {
  return name.startsWith("local-");
}

export function getPreset(name: string): EmbeddingPreset | null {
  return EMBEDDING_PRESETS[name] ?? null;
}

export function listPresetNames(): string[] {
  return Object.keys(EMBEDDING_PRESETS);
}
