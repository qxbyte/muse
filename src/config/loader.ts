/**
 * 配置加载：
 *   1. 内置默认值
 *   2. ~/.muse/settings.json
 *   3. <cwd>/.muse/settings.json
 *   4. <cwd>/.muse/settings.local.json
 *   5. 环境变量 (MUSE_*)
 *   6. CLI flags (在 cli.tsx 里覆盖)
 *
 * ${ENV_VAR} 占位符在加载后展开。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SettingsSchema, type Settings } from "./types.js";
import { expandEnvVars } from "./_env.js";
import { log } from "../log/index.js";

const DEFAULTS: Settings = {
  llm: {
    provider: "deepseek",
    model: "deepseek-chat",
  },
  providers: {
    deepseek: { apiKey: "${DEEPSEEK_API_KEY}" },
    openai: { apiKey: "${OPENAI_API_KEY}" },
    qwen: { apiKey: "${DASHSCOPE_API_KEY}" },
    moonshot: { apiKey: "${MOONSHOT_API_KEY}" },
    zhipu: { apiKey: "${ZHIPU_API_KEY}" },
    openrouter: { apiKey: "${OPENROUTER_API_KEY}" },
    ollama: { baseUrl: "http://localhost:11434/v1" },
  },
  permissions: {
    allow: ["Read", "Grep", "Glob"],
    ask: ["Write", "Edit", "Bash"],
    deny: [],
    defaultMode: "ask",
  },
  ui: {
    showBanner: true,
    lang: "en",
  },
};

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`Failed to parse settings at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** 深合并：高优先级覆盖低优先级。对象递归，数组/标量覆盖。 */
function deepMerge<T>(low: T, high: Partial<T>): T {
  if (high == null) return low;
  if (typeof low !== "object" || typeof high !== "object" || low === null || high === null) {
    return high as T;
  }
  if (Array.isArray(high)) return high as unknown as T;
  const result: Record<string, unknown> = { ...(low as Record<string, unknown>) };
  for (const [k, v] of Object.entries(high)) {
    const existing = (low as Record<string, unknown>)[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[k] = deepMerge(existing, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

export interface LoadedSettings {
  settings: Settings;
  sources: string[];
}

export async function loadSettings(cwd: string = process.cwd()): Promise<LoadedSettings> {
  const sources: string[] = ["<defaults>"];
  let merged: Settings = DEFAULTS;

  const candidates = [
    join(homedir(), ".muse", "settings.json"),
    join(cwd, ".muse", "settings.json"),
    join(cwd, ".muse", "settings.local.json"),
  ];

  for (const path of candidates) {
    const raw = await readJsonIfExists(path);
    if (raw != null) {
      const parsed = SettingsSchema.safeParse(raw);
      if (parsed.success) {
        merged = deepMerge(merged, parsed.data);
        sources.push(path);
      } else {
        log.warn(`Invalid settings at ${path}: ${parsed.error.message}`);
      }
    }
  }

  // Env overrides for the active LLM
  if (process.env.MUSE_PROVIDER && merged.llm) {
    merged = { ...merged, llm: { ...merged.llm, provider: process.env.MUSE_PROVIDER } };
    sources.push("env:MUSE_PROVIDER");
  }
  if (process.env.MUSE_MODEL && merged.llm) {
    merged = { ...merged, llm: { ...merged.llm, model: process.env.MUSE_MODEL } };
    sources.push("env:MUSE_MODEL");
  }

  // 展开 ${ENV_VAR} 占位符
  merged = expandEnvVars(merged) as Settings;

  return { settings: merged, sources };
}

export { DEFAULTS };
export { resolve as resolvePath };
