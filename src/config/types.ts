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
// 因此两者都可选——/models 切换只写 model，不写 provider。
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

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.optional(),
  providers: z.record(ProviderConfigSchema).optional(),
  permissions: PermissionsSchema.optional(),
  ui: UISchema.optional(),
  mcpServers: z.record(z.unknown()).optional(),
  skills: z.object({
    enabled: z.boolean().optional(),
    disabled: z.array(z.string()).optional(),
  }).optional(),
}).passthrough();

export type Settings = z.infer<typeof SettingsSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
