/**
 * Plugin loader:读 enabledPlugins → 定位 cache → 解析 manifest → 注入各 registry。
 *
 * 设计文档:模块设计/Plugins/设计.md §七。
 *
 * 启动期全量加载;单个 plugin 失败(缺失 / manifest 非法 / apiVersion 不兼容 /
 * register 抛错)→ 计入 errors,不阻塞其他 plugin 与 muse 启动。
 *
 * 声明式组件(skills / mcpServers / hooks)以 contributions 返回,由 cli 合并进
 * SkillRegistry / settings.mcpServers / HooksConfig;tools / slash 经 main register 直接注册。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HooksConfig, HookSpec } from "../config/types.js";
import type { MCPServerConfig } from "../mcp/types.js";
import type { SkillFile } from "../skills/types.js";
import type { AnyTool } from "../tools/types.js";
import type { SlashCommand } from "../slash/types.js";
import {
  PLUGIN_API_VERSION,
  PluginManifestSchema,
  type PluginManifest,
  type PluginLogger,
  type PluginLoadResult,
} from "./types.js";
import { createPluginPaths, listPluginVersions, type PluginPaths } from "./cache.js";
import {
  createPluginContext,
  resolvePluginSkills,
  resolvePluginMcpServers,
  resolvePluginHooks,
  type PathVars,
  type PluginSink,
} from "./register.js";

export interface PluginContributions {
  skills: SkillFile[];
  mcpServers: Record<string, MCPServerConfig>;
  hooks: HooksConfig;
  /** main register(ctx) 收集的 tool(已 <plugin>: namespace);cli 注册进 ToolRegistry。 */
  tools: AnyTool[];
  /** main register(ctx) 收集的 slash(已 <plugin>: namespace);app 注册进 SlashRegistry。 */
  slash: SlashCommand[];
}

export interface LoadPluginsOpts {
  enabledPlugins: Record<string, boolean>;
  cwd: string;
  logger: PluginLogger;
  paths?: PluginPaths; // 测试可注入;默认 ~/.muse/plugins
}

export async function loadEnabledPlugins(
  opts: LoadPluginsOpts,
): Promise<{ contributions: PluginContributions; result: PluginLoadResult }> {
  const paths = opts.paths ?? createPluginPaths();
  const contributions: PluginContributions = { skills: [], mcpServers: {}, hooks: {}, tools: [], slash: [] };
  const result: PluginLoadResult = { loaded: [], errors: [] };

  for (const [key, on] of Object.entries(opts.enabledPlugins ?? {})) {
    if (!on) continue;
    try {
      const ref = parsePluginKey(key);
      const versionDir = latestVersionDir(paths, ref.marketplace, ref.plugin);
      if (!versionDir) {
        result.errors.push({ plugin: key, reason: "not installed (run /plugin install)" });
        continue;
      }
      const manifest = loadPluginManifest(versionDir);
      if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        result.errors.push({
          plugin: key,
          reason: `apiVersion ${manifest.apiVersion} incompatible (host ${PLUGIN_API_VERSION})`,
        });
        continue;
      }
      const name = manifest.name ?? ref.plugin;
      const vars: PathVars = {
        MUSE_PLUGIN_ROOT: versionDir,
        MUSE_PLUGIN_DATA: paths.pluginDataDir(name),
        MUSE_PROJECT_DIR: opts.cwd,
      };

      // 声明式:skills
      const skillErrs: { reason: string }[] = [];
      contributions.skills.push(...resolvePluginSkills(versionDir, manifest, name, skillErrs));
      for (const e of skillErrs) result.errors.push({ plugin: key, reason: e.reason });

      // 声明式:mcpServers
      Object.assign(contributions.mcpServers, resolvePluginMcpServers(versionDir, manifest, name, vars));

      // 声明式:hooks
      mergeHooks(contributions.hooks, resolvePluginHooks(versionDir, manifest, vars));

      // 编程式:main register(tools / slash)
      if (manifest.main) {
        const mainPath = resolve(versionDir, manifest.main);
        const mod = (await import(mainPath)) as Record<string, unknown>;
        const reg = (mod.default ?? mod.register) as ((ctx: unknown) => unknown) | undefined;
        if (typeof reg === "function") {
          const sink: PluginSink = { tools: contributions.tools, slash: contributions.slash };
          const ctx = createPluginContext({
            plugin: { name, version: manifest.version ?? "0.0.0", root: versionDir, dataDir: vars.MUSE_PLUGIN_DATA },
            sink,
            logger: opts.logger,
          });
          await reg(ctx);
        } else {
          result.errors.push({ plugin: key, reason: `main ${manifest.main} has no default/register export` });
        }
      }

      result.loaded.push(key);
    } catch (err) {
      result.errors.push({ plugin: key, reason: (err as Error).message });
    }
  }

  return { contributions, result };
}

// ============================== helpers ==============================

/** "<plugin>@<marketplace>" → { plugin, marketplace }。 */
export function parsePluginKey(key: string): { plugin: string; marketplace: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) {
    throw new Error(`invalid plugin key "${key}" (expected <plugin>@<marketplace>)`);
  }
  return { plugin: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** 选最新缓存版本目录(版本名降序取首);无 → null。 */
function latestVersionDir(paths: PluginPaths, marketplace: string, plugin: string): string | null {
  const versions = listPluginVersions(paths, marketplace, plugin);
  if (versions.length === 0) return null;
  const latest = [...versions].sort().at(-1)!;
  return paths.pluginCacheDir(marketplace, plugin, latest);
}

/** 读 .muse-plugin/plugin.json;无 manifest → 合成最小可用(按目录约定加载)。 */
function loadPluginManifest(versionDir: string): PluginManifest {
  const file = join(versionDir, ".muse-plugin", "plugin.json");
  if (!existsSync(file)) {
    return PluginManifestSchema.parse({ apiVersion: PLUGIN_API_VERSION });
  }
  const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
  if (!parsed.success) {
    throw new Error(`invalid plugin.json: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/** 把 src 的 hooks 链式追加到 target(同 point concat)。 */
function mergeHooks(target: HooksConfig, src: HooksConfig): void {
  for (const [point, specs] of Object.entries(src) as [keyof HooksConfig, HookSpec[]][]) {
    if (!specs) continue;
    const cur = (target[point] ?? []) as HookSpec[];
    target[point] = [...cur, ...specs] as HooksConfig[keyof HooksConfig];
  }
}
