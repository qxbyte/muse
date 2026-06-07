/**
 * Models registry：用户级模型库。
 *
 * 位置：~/.muse/models.local.json （单文件，本机本地；从不入 git）
 *
 * 设计：
 * - models 数组的 id 是**用户起的名字**,不在代码里硬编码;数组里所有 entry 都自动进
 *   /model selector,无需额外过滤字段
 * - apiKey 字段可以直接写明文（推荐：文件就在本机本地），也支持 ${ENV_VAR} 占位符
 * - baseUrl 是基址，SDK 自己拼 /chat/completions；用户填全 endpoint 时自动剥后缀
 * - 不存在文件 → 返回 undefined（调用方回退到 settings.json llm 配置）
 *
 * Why `.local.json` 单文件而非 `models.json`：
 *   muse 0.1.x 早期是双文件（models.json git-tracked + models.local.json 本地兜底），
 *   但实际使用中并没有 "git-track 一份不含 key 的模板" 的场景——用户的模型清单本就
 *   是私人物件。为避免新用户被两份文件混淆，合并为单文件，沿用 `.local.json`
 *   后缀作为 "本机本地，绝不入 git" 的视觉提示。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expandEnvVars } from "./_env.js";
import { log } from "../log/index.js";

/**
 * 内部规整后的 ModelEntry 类型。schema 解析后的对象会通过 normalize 步骤
 * 把 url/baseUrl 合一，最终 baseUrl 保证非空。业务（client / selector）只看本类型。
 */
export interface ModelEntry {
  id: string;
  name?: string;
  vendor?: string;
  apiKey?: string;
  baseUrl: string;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  [k: string]: unknown;
}

/**
 * 输入校验：baseUrl / url 任一非空即可。
 * 用户实际写的 models.local.json 多用 `url`（OpenAI 兼容协议惯例命名），
 * 我们接受两种别名，normalize 阶段归一。
 */
export const ModelEntryInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    vendor: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    url: z.string().optional(),
    supportsToolCall: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
  })
  .passthrough()
  .refine((d) => Boolean(d.baseUrl || d.url), {
    message: "Either 'baseUrl' or 'url' is required",
    path: ["baseUrl"],
  });

export type ModelEntryInput = z.infer<typeof ModelEntryInputSchema>;

export const ModelsRegistryInputSchema = z
  .object({
    models: z.array(ModelEntryInputSchema),
  })
  .passthrough();

export type ModelsRegistryInput = z.infer<typeof ModelsRegistryInputSchema>;

/** Normalize 后的 registry：models[*].baseUrl 保证非空。 */
export interface ModelsRegistry {
  models: ModelEntry[];
  [k: string]: unknown;
}

export interface LoadError {
  path: string;
  message: string;
}

export interface LoadedModels {
  registry: ModelsRegistry | undefined;
  sources: string[];
  errors: LoadError[];
}

export const MODELS_PATH = (): string => join(homedir(), ".muse", "models.local.json");

export async function loadModelsRegistry(): Promise<LoadedModels> {
  const sources: string[] = [];
  const errors: LoadError[] = [];
  const path = MODELS_PATH();

  if (!existsSync(path)) {
    return { registry: undefined, sources, errors };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    const msg = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(`Failed to parse ${path}: ${msg}`);
    errors.push({ path, message: msg });
    return { registry: undefined, sources, errors };
  }

  const parsed = ModelsRegistryInputSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = formatZodIssues(parsed.error.issues);
    log.warn(`Invalid models registry at ${path}: ${msg}`);
    errors.push({ path, message: msg });
    return { registry: undefined, sources, errors };
  }

  const normalized: ModelsRegistry = {
    ...parsed.data,
    models: parsed.data.models.map(normalizeModelEntry),
  };
  sources.push(path);
  const expanded = expandEnvVars(normalized) as ModelsRegistry;
  return { registry: expanded, sources, errors };
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/**
 * 输入归一：url ↔ baseUrl 二选一；剥 trailing `/` 与 `/chat/completions`。
 * 经过校验后 baseUrl/url 至少一个非空（zod refine 保证），输出 baseUrl 必填。
 *
 * 同时记录 apiKey 字段里出现的 ${ENV_VAR} 占位符名（_apiKeyEnvVars），让 expand 后
 * apiKey 变空时 client.ts 能给出"缺哪个 env var"的精确提示。
 */
function normalizeModelEntry(entry: ModelEntryInput): ModelEntry {
  let baseUrl = (entry.baseUrl ?? entry.url ?? "").replace(/\/+$/, "");
  if (baseUrl.endsWith("/chat/completions")) {
    baseUrl = baseUrl.slice(0, -"/chat/completions".length);
  }
  const { url: _url, ...rest } = entry;
  const apiKeyEnvVars = entry.apiKey ? extractEnvVars(entry.apiKey) : [];
  return {
    ...rest,
    baseUrl,
    ...(apiKeyEnvVars.length > 0 ? { _apiKeyEnvVars: apiKeyEnvVars } : {}),
  };
}

const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
function extractEnvVars(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ENV_PLACEHOLDER.lastIndex = 0;
  while ((m = ENV_PLACEHOLDER.exec(s)) !== null) out.push(m[1]);
  return out;
}

// ---------- selector / lookup helpers ----------

export function findEntry(registry: ModelsRegistry, modelId: string): ModelEntry | undefined {
  return registry.models.find((m) => m.id === modelId);
}

