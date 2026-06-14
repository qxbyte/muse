/**
 * Plugin 管理操作(/plugin 命令的内核)。
 *
 * 设计文档:模块设计/Plugins/设计.md §九。
 *
 * 所有操作接受显式 paths(PluginPaths)+ settingsPath,便于测试注入 tmpdir;
 * slash 命令(src/slash/plugin.ts)用真实路径薄包装 + 格式化输出。
 *
 * 改动只落 cache + settings.json;生效需重启(或后续 /reload-plugins)。
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import type { PluginPaths } from "./cache.js";
import { upsertKnownMarketplace, removeKnownMarketplace, readKnownMarketplaces } from "./cache.js";
import { fetchMarketplace, fetchPlugin } from "./fetch.js";
import {
  loadMarketplaceManifest,
  normalizeMarketplaceSource,
  findPluginEntry,
} from "./marketplace.js";
import { parsePluginKey } from "./loader.js";
import type { MarketplaceSource } from "./types.js";

export type SettingsScope = "user" | "project" | "local";

/** scope → settings.json 路径。home/cwd 可注入(测试)。 */
export function settingsPathForScope(scope: SettingsScope, opts: { home?: string; cwd: string }): string {
  const home = opts.home ?? homedir();
  switch (scope) {
    case "user":
      return join(home, ".muse", "settings.json");
    case "project":
      return join(opts.cwd, ".muse", "settings.json");
    case "local":
      return join(opts.cwd, ".muse", "settings.local.json");
  }
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** read-modify-write 整文件(pretty 2 空格),对齐 persistActiveModel 风格。 */
export function patchSettings(path: string, fn: (cur: Record<string, unknown>) => void): void {
  const cur = readSettings(path);
  fn(cur);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cur, null, 2)}\n`);
}

// ============================== marketplace ==============================

export interface AddMarketplaceResult {
  name: string;
  pluginCount: number;
}

/**
 * 添加 marketplace:fetch → 读 name → 安置到 cache → 写 known + settings。
 * source 为字符串(用户输入)或已规范化对象。
 */
export async function addMarketplace(opts: {
  source: string | MarketplaceSource;
  paths: PluginPaths;
  settingsPath: string;
}): Promise<AddMarketplaceResult> {
  const source = normalizeMarketplaceSource(opts.source);
  // 先 fetch 到 staging,读 name 后再安置(name 来自 marketplace.json)
  const staging = join(opts.paths.root, ".staging-marketplace");
  rmSync(staging, { recursive: true, force: true });
  await fetchMarketplace(source, staging);
  const manifest = loadMarketplaceManifest(staging);
  const dest = opts.paths.marketplaceDir(manifest.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(staging, dest);

  upsertKnownMarketplace(opts.paths, manifest.name, source);
  patchSettings(opts.settingsPath, (cur) => {
    const m = (cur.extraKnownMarketplaces as Record<string, unknown>) ?? {};
    m[manifest.name] = { source };
    cur.extraKnownMarketplaces = m;
  });
  return { name: manifest.name, pluginCount: manifest.plugins.length };
}

export function listMarketplaces(paths: PluginPaths): { name: string; source: MarketplaceSource }[] {
  const known = readKnownMarketplaces(paths);
  return Object.entries(known).map(([name, rec]) => ({ name, source: rec.source }));
}

export function removeMarketplace(opts: { name: string; paths: PluginPaths; settingsPath: string }): boolean {
  const removed = removeKnownMarketplace(opts.paths, opts.name);
  rmSync(opts.paths.marketplaceDir(opts.name), { recursive: true, force: true });
  patchSettings(opts.settingsPath, (cur) => {
    const m = cur.extraKnownMarketplaces as Record<string, unknown> | undefined;
    if (m) delete m[opts.name];
  });
  return removed;
}

// ============================== plugin ==============================

export interface InstallResult {
  key: string;
  version: string;
}

/** 安装 plugin:从 marketplace 解析 source → fetch 到 cache 版本目录 → enabledPlugins=true。 */
export async function installPlugin(opts: {
  key: string; // <plugin>@<marketplace>
  paths: PluginPaths;
  settingsPath: string;
}): Promise<InstallResult> {
  const { plugin, marketplace } = parsePluginKey(opts.key);
  const mpDir = opts.paths.marketplaceDir(marketplace);
  if (!existsSync(mpDir)) {
    throw new Error(`marketplace "${marketplace}" not added (run /plugin marketplace add)`);
  }
  const manifest = loadMarketplaceManifest(mpDir);
  const entry = findPluginEntry(manifest, plugin);
  if (!entry) throw new Error(`plugin "${plugin}" not found in marketplace "${marketplace}"`);
  const version = entry.version ?? "0.0.0";
  const dest = opts.paths.pluginCacheDir(marketplace, plugin, version);
  await fetchPlugin({ entry, manifest, marketplaceDir: mpDir, destVersionDir: dest });
  setPluginEnabled({ key: opts.key, enabled: true, settingsPath: opts.settingsPath });
  return { key: opts.key, version };
}

export function setPluginEnabled(opts: { key: string; enabled: boolean; settingsPath: string }): void {
  patchSettings(opts.settingsPath, (cur) => {
    const e = (cur.enabledPlugins as Record<string, boolean>) ?? {};
    e[opts.key] = opts.enabled;
    cur.enabledPlugins = e;
  });
}

export function uninstallPlugin(opts: {
  key: string;
  paths: PluginPaths;
  settingsPath: string;
  purgeCache?: boolean;
}): void {
  patchSettings(opts.settingsPath, (cur) => {
    const e = cur.enabledPlugins as Record<string, boolean> | undefined;
    if (e) delete e[opts.key];
  });
  if (opts.purgeCache) {
    const { plugin, marketplace } = parsePluginKey(opts.key);
    rmSync(join(opts.paths.cacheDir, marketplace, plugin), { recursive: true, force: true });
  }
}

export interface PluginListItem {
  key: string;
  enabled: boolean;
  installed: boolean;
}

/** 列出 marketplaces 里的所有 plugin + 启用/安装状态。 */
export function listPlugins(opts: {
  paths: PluginPaths;
  enabledPlugins: Record<string, boolean>;
}): PluginListItem[] {
  const out: PluginListItem[] = [];
  for (const { name: mp } of listMarketplaces(opts.paths)) {
    const mpDir = opts.paths.marketplaceDir(mp);
    let plugins: { name: string }[] = [];
    try {
      plugins = loadMarketplaceManifest(mpDir).plugins;
    } catch {
      continue;
    }
    for (const p of plugins) {
      const key = `${p.name}@${mp}`;
      out.push({
        key,
        enabled: opts.enabledPlugins[key] === true,
        installed: existsSync(join(opts.paths.cacheDir, mp, p.name)),
      });
    }
  }
  return out;
}
