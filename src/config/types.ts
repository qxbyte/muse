/**
 * 配置 schema。对应 ~/.muse/settings.json + .muse/settings.json 的内容。
 */

import { z } from "zod";

export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  extraHeaders: z.record(z.string()).optional(),
}).passthrough();

// 新设计：model id 由 ~/.muse/models.local.json 提供，settings.json 只保留 active 选择。
// provider 字段仅用于"无 models.local.json 时的 fallback 路径"（设计文档 §8 兼容层）。
// 因此两者都可选——/model 切换只写 model，不写 provider。
export const LLMConfigSchema = z.object({
  provider: z.string().optional().describe("Fallback provider preset (only used when no models.local.json entry matches)."),
  model: z.string().optional().describe("Active model id; should match an id in models.local.json."),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const PermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  defaultMode: z.enum(["strict", "relaxed", "ask"]).optional(),
});

export const UISchema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  lang: z.enum(["en", "zh-CN"]).optional(),
  showBanner: z.boolean().optional(),
});

// 消息预处理工程(模块设计/消息预处理工程/设计.md §6.2)。
// MVP:settings 暴露 4 段管线开关 + 部分参数;hooks 只在 PreToolUse / PostToolUse 触发,
// 其余点位 schema 保留但不接代码。

export const HookSpecSchema = z.object({
  matcher: z.string().optional(),
  command: z.string(),
  timeout: z.number().int().positive().optional(),
  onError: z.enum(["skip", "throw"]).optional(),
});

export const HooksConfigSchema = z.object({
  SessionStart: z.array(HookSpecSchema).optional(),
  SessionEnd: z.array(HookSpecSchema).optional(),
  UserPromptSubmit: z.array(HookSpecSchema).optional(),
  PreLLMRequest: z.array(HookSpecSchema).optional(),
  PostLLMResponse: z.array(HookSpecSchema).optional(),
  PreToolUse: z.array(HookSpecSchema).optional(),
  PostToolUse: z.array(HookSpecSchema).optional(),
  PreCompact: z.array(HookSpecSchema).optional(),
  PostCompact: z.array(HookSpecSchema).optional(),
  MemoryPromote: z.array(HookSpecSchema).optional(),
}).passthrough();

export const InputPreprocessSettingsSchema = z.object({
  atFileExpand: z.object({
    enabled: z.boolean().optional(),
    maxBytes: z.number().int().positive().optional(),
  }).optional(),
  templateExpand: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  maxChars: z.number().int().positive().optional(),
  redactPreScan: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
}).passthrough();

export const RequestPreprocessSettingsSchema = z.object({
  trimHistory: z.object({
    enabled: z.boolean().optional(),
    /** 触发裁剪的预算占比阈值(默认 0.8)。 */
    budgetRatio: z.number().min(0).max(1).optional(),
    /** 裁剪到此预算占比以下停手(默认 0.6,I-1 ADR #3)。 */
    targetRatio: z.number().min(0).max(1).optional(),
    /** I-1:被切段内的 user 消息原文是否保留(默认 true);false 回旧 marker 行为。 */
    preserveUserMessages: z.boolean().optional(),
  }).optional(),
  budgetGuard: z.object({
    enabled: z.boolean().optional(),
    budgetRatio: z.number().min(0).max(1).optional(),
    /** I-5:budget-guard 自动 compact 是否把 LLM 提取的 facts promote 到 memory(默认 true)。 */
    promoteFactsToMemory: z.boolean().optional(),
  }).optional(),
  compact: z.object({
    /** I-2 摘要模板:"9-section"(默认 / 信息密度高)/ "6-section"(降级 / 容错性高)。 */
    schema: z.enum(["9-section", "6-section"]).optional(),
    /** O3:9-section LLM 流失败时自动用 6-section 重试一次(默认 true)。 */
    fallbackOnFormatFail: z.boolean().optional(),
    /** O4:source=compact-promote 写入前检查同名 memory 是否已存在(默认 true,跳过不覆盖)。 */
    dedupPromotedFacts: z.boolean().optional(),
  }).optional(),
  injectMemory: z.object({
    /** O1:budget 紧张时按占比动态降量(默认 true);false 锁死满量注入,
     *  适合 contextWindow 配置不准或希望可预测注入大小的场景。 */
    budgetScaleEnabled: z.boolean().optional(),
  }).optional(),
  tokenize: z.object({
    /** O2:image part token 估算常量(默认 1500;vision 模型高分辨率上限)。
     *  vision 模型按 tile / resolution 计费,占位文本无法预知真值;调高 → 早 trim
     *  保守,调低 → 鼓励多带图但有撞 context window 风险。 */
    imageTokenEstimate: z.number().int().positive().optional(),
  }).optional(),
  redact: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
}).passthrough();

export const ResultPreprocessSettingsSchema = z.object({
  truncate: z.object({
    budgetBytes: z.number().int().positive().optional(),
  }).optional(),
  detectBinary: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  summarize: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  normalizeError: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  redact: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  injectDiff: z.boolean().optional(),
}).passthrough();

export const RenderPreprocessSettingsSchema = z.object({
  streamMarkdown: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  collapseLong: z.object({
    enabled: z.boolean().optional(),
    threshold: z.number().int().positive().optional(),
  }).optional(),
}).passthrough();

export const PreprocessSettingsSchema = z.object({
  input: InputPreprocessSettingsSchema.optional(),
  request: RequestPreprocessSettingsSchema.optional(),
  result: ResultPreprocessSettingsSchema.optional(),
  render: RenderPreprocessSettingsSchema.optional(),
  /** 全局禁用的 stage name 列表(kebab-case)。 */
  disable: z.array(z.string()).optional(),
}).passthrough();

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.optional(),
  providers: z.record(ProviderConfigSchema).optional(),
  permissions: PermissionsSchema.optional(),
  ui: UISchema.optional(),
  mcpServers: z.record(z.unknown()).optional(),
  /**
   * Skills 模块设置(模块设计/扩展接入口/设计.md §五.10)。
   *
   * Skills 是 markdown prompt 包(SKILL.md + frontmatter),两层 scope:
   *   personal  ~/.muse/skills/<name>/SKILL.md         跨项目用户级
   *   project   <cwd>/.muse/skills/<name>/SKILL.md     项目级,可入 git
   * 冲突时 project 覆盖 personal。
   */
  skills: z.object({
    /** 全局开关;false 时不扫不加载(零开销)。 */
    enabled: z.boolean().optional(),
    /** skill name 黑名单(personal + project 都跳)。 */
    disabled: z.array(z.string()).optional(),
    /** personal 目录路径(默认 ~/.muse/skills)。 */
    personalDir: z.string().optional(),
    /** project 目录路径,相对 cwd(默认 .muse/skills)。 */
    projectDir: z.string().optional(),
  }).optional(),
  hooks: HooksConfigSchema.optional(),
  preprocess: PreprocessSettingsSchema.optional(),
  /**
   * 启动时注入到 process.env 的额外环境变量(对齐业界 CLI Agent 的 settings.env 模式)。
   * 值必须是字符串(JSON 无 number→env 的隐式转换;约束传 "1" / "0" 这种字面值)。
   *
   * 当前支持的 muse 自识别变量:
   *   MUSE_DISABLE_CURSOR_BLINK=1   关闭输入框光标闪烁(默认闪烁)
   *   其他 muse 模块可自行约定 MUSE_* 名字读取。
   *
   * 注意:这里写入的变量会进入 process.env,**但 Hook 子进程仍走环境变量白名单**
   * (见 src/preprocess/hooks.ts),不会自动透传给 hook 命令,避免泄露密钥。
   */
  env: z.record(z.string()).optional(),
  /** Memory 模块设置(II-5 向量索引)。 */
  memory: z.object({
    embedding: z.object({
      /** 启用 embedding 召回(默认 false;关闭时 inject-memory 走传统全文)。 */
      enabled: z.boolean().optional(),
      /** 后端 provider。默认 hash-bag(零依赖);设了 preset 自动走 openai-compatible。 */
      provider: z.enum(["hash-bag", "openai-compatible", "openai", "local-minilm"]).optional(),
      /** Preset 名(dashscope-v3 / openai-3-small / openai-3-large / zhipu-3 / ollama-nomic / ollama-bge-m3)。 */
      preset: z.string().optional(),
      /** Base URL(覆盖 preset 默认或自定义 provider 时填)。 */
      baseUrl: z.string().optional(),
      /** 模型名(覆盖 preset 默认或自定义 provider 时填)。 */
      model: z.string().optional(),
      /** 向量维度(用户根据模型官方说明调整;preset 给推荐默认,可覆盖)。
       *  设了此字段 → HTTP 请求带 dimensions 参数(MRL truncation);
       *  没设 → 走模型默认。
       *  启动期 muse 会 probe 一次校验实际维度,不匹配则降级 hash-bag + 提示修正。 */
      dim: z.number().int().positive().optional(),
      /** API key(${ENV_VAR} 或明文;Ollama 等本地端点可省)。 */
      apiKey: z.string().optional(),
      /** 检索 top-K(默认 5)。 */
      topK: z.number().int().positive().optional(),
      /** memory 数量低于此值时退化到全注入(默认 3,2026-06-07 R5 修订)。 */
      minMemoryCount: z.number().int().nonnegative().optional(),
      /** 注入 token 预算上限,超出按 trust 优先保留(默认 1500)。 */
      maxInjectTokens: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

export type Settings = z.infer<typeof SettingsSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type HookSpec = z.infer<typeof HookSpecSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export type PreprocessSettings = z.infer<typeof PreprocessSettingsSchema>;
export type InputPreprocessSettings = z.infer<typeof InputPreprocessSettingsSchema>;
export type RequestPreprocessSettings = z.infer<typeof RequestPreprocessSettingsSchema>;
export type ResultPreprocessSettings = z.infer<typeof ResultPreprocessSettingsSchema>;
export type RenderPreprocessSettings = z.infer<typeof RenderPreprocessSettingsSchema>;
