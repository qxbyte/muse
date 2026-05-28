/**
 * 配置 schema。对应 ~/.muse/settings.json + .muse/settings.json 的内容。
 */

import { z } from "zod";

export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  extraHeaders: z.record(z.string()).optional(),
}).passthrough();

export const LLMConfigSchema = z.object({
  provider: z.string().describe("Provider preset name or custom."),
  model: z.string(),
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
