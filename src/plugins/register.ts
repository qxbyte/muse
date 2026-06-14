/**
 * Plugin 组件解析 + PluginContext 实现。
 *
 * 设计文档:模块设计/Plugins/设计.md §七 / §八。
 *
 * - 声明式组件(manifest 的 skills / mcpServers / hooks)由 host 扫描 → 各 registry。
 * - 编程式(main register(ctx))只用于 tools / slash;registerHook 的 JS 函数在 v0.4
 *   host 无执行通路(host hooks 是 shell 命令),故仅 warn 提示走声明式 hooks.json。
 * - 路径变量 ${MUSE_PLUGIN_ROOT} / ${MUSE_PLUGIN_DATA} / ${MUSE_PROJECT_DIR} 注入前替换。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SlashCommand } from "../slash/types.js";
import type { AnyTool } from "../tools/types.js";
import type { HookPoint } from "../preprocess/hooks.js";
import type { HooksConfig } from "../config/types.js";
import type { MCPServerConfig } from "../mcp/types.js";
import { parseSkillFile } from "../skills/parser.js";
import type { SkillFile } from "../skills/types.js";
import type { PluginContext, PluginManifest, PluginLogger } from "./types.js";

export interface PathVars {
  MUSE_PLUGIN_ROOT: string;
  MUSE_PLUGIN_DATA: string;
  MUSE_PROJECT_DIR: string;
}

/** 深度替换字符串里的 ${VAR}(对 string / array / object 递归)。 */
export function substitutePathVars<T>(value: T, vars: PathVars): T {
  if (typeof value === "string") {
    return value.replace(/\$\{(MUSE_PLUGIN_ROOT|MUSE_PLUGIN_DATA|MUSE_PROJECT_DIR)\}/g, (_, k) =>
      (vars as unknown as Record<string, string>)[k] ?? "",
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitutePathVars(v, vars)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePathVars(v, vars);
    return out as T;
  }
  return value;
}

/** manifest 字段(string | string[] | 缺省)→ 绝对目录列表;缺省走 defaultRel。 */
function manifestDirs(field: string | string[] | undefined, pluginDir: string, defaultRel: string): string[] {
  const rels = field == null ? [defaultRel] : Array.isArray(field) ? field : [field];
  return rels.map((r) => resolve(pluginDir, r));
}

/** 扫 plugin 的 skill 目录 → SkillFile[](scope=plugin)。解析失败计入 errors。 */
export function resolvePluginSkills(
  pluginDir: string,
  manifest: PluginManifest,
  pluginName: string,
  errors: { reason: string }[],
): SkillFile[] {
  const out: SkillFile[] = [];
  // 无 skills 字段且根有 SKILL.md → 视作单技能
  const rootSkill = join(pluginDir, "SKILL.md");
  if (manifest.skills == null && existsSync(rootSkill)) {
    pushSkill(rootSkill, pluginDir, pluginName, out, errors);
    return out;
  }
  for (const dir of manifestDirs(manifest.skills, pluginDir, "skills")) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillMd = join(dir, entry, "SKILL.md");
      if (existsSync(skillMd)) pushSkill(skillMd, join(dir, entry), pluginName, out, errors);
    }
  }
  return out;
}

function pushSkill(
  filePath: string,
  dirPath: string,
  pluginName: string,
  out: SkillFile[],
  errors: { reason: string }[],
): void {
  try {
    const { frontmatter, body } = parseSkillFile(readFileSync(filePath, "utf-8"));
    out.push({ name: frontmatter.name, frontmatter, body, filePath, dirPath, scope: "plugin", pluginName });
  } catch (err) {
    errors.push({ reason: `skill ${filePath}: ${(err as Error).message}` });
  }
}

/** manifest.mcpServers(路径或内联)→ namespaced Record<string, MCPServerConfig>(key 加 `<plugin>.`)。 */
export function resolvePluginMcpServers(
  pluginDir: string,
  manifest: PluginManifest,
  pluginName: string,
  vars: PathVars,
): Record<string, MCPServerConfig> {
  let raw: Record<string, unknown> | undefined;
  if (typeof manifest.mcpServers === "string") {
    const file = resolve(pluginDir, manifest.mcpServers);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      raw = (parsed.mcpServers ?? parsed) as Record<string, unknown>;
    }
  } else if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
    raw = manifest.mcpServers as Record<string, unknown>;
  }
  if (!raw) return {};
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    out[`${pluginName}.${name}`] = substitutePathVars(cfg, vars) as MCPServerConfig;
  }
  return out;
}

/** manifest.hooks(路径或内联)→ HooksConfig(command 已做路径变量替换)。 */
export function resolvePluginHooks(pluginDir: string, manifest: PluginManifest, vars: PathVars): HooksConfig {
  let raw: unknown;
  if (typeof manifest.hooks === "string") {
    const file = resolve(pluginDir, manifest.hooks);
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf-8"));
  } else if (manifest.hooks && typeof manifest.hooks === "object") {
    raw = manifest.hooks;
  }
  if (!raw) return {};
  return substitutePathVars(raw, vars) as HooksConfig;
}

/**
 * 收集 plugin 经 main register(ctx) 注册的 tool / slash(带 `<plugin>:` namespace)。
 * 用 sink 收集而非直接写 live registry:ToolRegistry 在 cli、SlashRegistry 在 app,
 * 由各自 consumer 在合适时机注册(并做冲突跳过)。
 */
export interface PluginSink {
  tools: AnyTool[];
  slash: SlashCommand[];
}

/** 创建 PluginContext(给 main register(ctx));注册结果收进 sink。 */
export function createPluginContext(opts: {
  plugin: { name: string; version: string; root: string; dataDir: string };
  sink: PluginSink;
  logger: PluginLogger;
}): PluginContext {
  const { plugin, sink, logger } = opts;
  const ns = (n: string) => (n.startsWith(`${plugin.name}:`) ? n : `${plugin.name}:${n}`);
  return {
    plugin,
    registerTool(tool: AnyTool) {
      sink.tools.push({ ...tool, name: ns(tool.name) });
    },
    registerSlash(cmd: SlashCommand) {
      sink.slash.push({ ...cmd, name: ns(cmd.name) });
    },
    registerHook(_point: HookPoint) {
      // v0.4:host hooks 是 shell 命令,JS 函数 hook 无执行通路。请用 manifest hooks/hooks.json。
      logger.warn(
        `[plugin:${plugin.name}] registerHook(JS fn) not executed in v0.4 — declare hooks via manifest hooks/hooks.json`,
      );
    },
    logger,
  };
}
