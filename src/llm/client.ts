/**
 * LLMClient 工厂：根据配置创建对应 provider 的客户端。
 *
 * 当前只实现 openai-compatible 协议族（覆盖 95% 国产模型 + OpenAI 本身）。
 * Anthropic 走自己的协议，留待 v0.3 加。
 */

import { createPresetClient, PRESETS, OpenAICompatibleClient } from "./providers/index.js";
import type { LLMClient, ModelCapabilities, ProviderConfig } from "./types.js";
import { MuseError } from "../types/index.js";
import type { ModelEntry } from "../config/models.js";

export interface CreateClientOpts {
  provider: string;
  model: string;
  providers: Record<string, ProviderConfig>;
}

/**
 * 当前 active model 的 apiKey 注入到此进程 env 字段下。
 *
 * 业务代码（LLM client）只看到 env name，不直接持有 key 副本。
 * /models 切换或启动加载时由 setActiveModelEnv() 写入；从这里读出来给 client。
 */
export const ACTIVE_API_KEY_ENV = "MUSE_ACTIVE_API_KEY";

/** 把 entry 的 apiKey 注入 process.env，供 createLLMClientFromModelEntry 读取。 */
export function setActiveModelEnv(entry: ModelEntry): void {
  if (entry.apiKey) {
    process.env[ACTIVE_API_KEY_ENV] = entry.apiKey;
  } else {
    delete process.env[ACTIVE_API_KEY_ENV];
  }
}

/**
 * 从用户在 models.local.json 里定义的 ModelEntry 构造 LLMClient。
 *
 * apiKey 不直接传值——而是从 process.env[ACTIVE_API_KEY_ENV] 读，调用前必须先
 * setActiveModelEnv(entry) 写入。这样业务代码只看到 env name，不直接持有 key。
 *
 * vendor 字段仅用于显示（providerName 显示在 banner / /status）。
 * 当前所有 entry 走 openai-compatible 协议；未来引入其他协议时按 entry.protocol 分流。
 */
export function createLLMClientFromModelEntry(entry: ModelEntry): LLMClient {
  const apiKey = process.env[ACTIVE_API_KEY_ENV] ?? "";
  if (!apiKey && !entry.baseUrl.includes("localhost")) {
    throw new MuseError(buildMissingKeyMessage(entry), "MISSING_API_KEY");
  }
  const capabilities: Partial<ModelCapabilities> = {};
  if (entry.supportsToolCall !== undefined) capabilities.toolCalling = entry.supportsToolCall;
  if (entry.supportsImages !== undefined) capabilities.vision = entry.supportsImages;
  if (entry.contextWindow !== undefined) capabilities.maxContextWindow = entry.contextWindow;

  return new OpenAICompatibleClient({
    providerName: entry.vendor ?? "custom",
    baseUrl: entry.baseUrl,
    apiKey,
    model: entry.id,
    capabilities,
  });
}

/**
 * 用户向报错：当 apiKey 是 ${VAR} 占位符但 VAR 没设时，告诉用户具体缺哪个 env var
 * 和三种修复方式；不是占位符 / 直接缺字段时退化为通用提示。
 */
function buildMissingKeyMessage(entry: ModelEntry): string {
  const envVars = ((entry as { _apiKeyEnvVars?: string[] })._apiKeyEnvVars ?? []).filter(
    (v) => !process.env[v],
  );
  const head = `Model "${entry.id}" needs an API key but none was found.`;

  if (envVars.length > 0) {
    const list = envVars.map((v) => `$${v}`).join(", ");
    const fixVar = envVars[0];
    return [
      head,
      ``,
      `Cause: ~/.muse/models.local.json sets apiKey to a placeholder referencing ${list},`,
      `       but the shell environment does not have ${envVars.length > 1 ? "those variables" : "that variable"} set.`,
      ``,
      `Fix (pick one):`,
      `  1. Replace the \${${fixVar}} placeholder in ~/.muse/models.local.json with the literal key`,
      `     (recommended — the file is local-only and never enters git).`,
      `  2. Export the variable in your shell:`,
      `       export ${fixVar}=<your-key>`,
    ].join("\n");
  }

  return [
    head,
    ``,
    `Edit ~/.muse/models.local.json and set "apiKey" on the "${entry.id}" entry`,
    `(plain text is fine — the file stays local-only).`,
  ].join("\n");
}

export function createLLMClient(opts: CreateClientOpts): LLMClient {
  const { provider, model, providers } = opts;
  const config = providers[provider];

  if (!config) {
    throw new MuseError(
      `Provider "${provider}" is not configured. Add a "providers.${provider}" entry to your settings.json.`,
      "PROVIDER_NOT_CONFIGURED",
    );
  }

  // 预设 provider（含国产模型）
  if (PRESETS[provider]) {
    if (!config.apiKey && provider !== "ollama") {
      throw new MuseError(
        `Provider "${provider}" requires apiKey. Set it in settings.json or via the corresponding env var.`,
        "MISSING_API_KEY",
      );
    }
    return createPresetClient(provider, config, model);
  }

  // 自定义 openai-compatible 端点
  if (config.baseUrl) {
    return new OpenAICompatibleClient({
      providerName: provider,
      baseUrl: config.baseUrl as string,
      apiKey: (config.apiKey as string | undefined) ?? "",
      model,
    });
  }

  throw new MuseError(
    `Unknown provider "${provider}". Either use a preset (${Object.keys(PRESETS).join(", ")}) or set "baseUrl" in providers.${provider}.`,
    "UNKNOWN_PROVIDER",
  );
}
