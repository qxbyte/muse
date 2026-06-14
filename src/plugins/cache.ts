/**
 * Plugin 缓存布局 + known_marketplaces 读写。
 *
 * 设计文档:模块设计/Plugins/设计.md §五。
 *
 * 布局:
 *   ~/.muse/plugins/
 *   ├── known_marketplaces.json          已添加 marketplace 的来源
 *   ├── marketplaces/<mp>/                marketplace 缓存(git clone / 本地)
 *   ├── cache/<mp>/<plugin>/<version>/    plugin 缓存(复制,每版本独立)
 *   └── data/<plugin>/                    ${MUSE_PLUGIN_DATA}(跨版本保留)
 *
 * 所有路径 helper 接受 root 覆盖(测试用 tmpdir,不碰真 ~/.muse)。
 * 用同步 fs:启动期 + 小文件,与 src/log 风格一致。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { z } from "zod";
import { MarketplaceSourceSchema, type MarketplaceSource } from "./types.js";

export function defaultPluginsRoot(): string {
  return join(homedir(), ".muse", "plugins");
}

export interface PluginPaths {
  root: string;
  marketplacesDir: string;
  cacheDir: string;
  dataDir: string;
  knownMarketplacesFile: string;
  marketplaceDir(name: string): string;
  pluginCacheDir(mp: string, plugin: string, version: string): string;
  pluginDataDir(plugin: string): string;
}

export function createPluginPaths(root: string = defaultPluginsRoot()): PluginPaths {
  return {
    root,
    marketplacesDir: join(root, "marketplaces"),
    cacheDir: join(root, "cache"),
    dataDir: join(root, "data"),
    knownMarketplacesFile: join(root, "known_marketplaces.json"),
    marketplaceDir: (name) => join(root, "marketplaces", name),
    pluginCacheDir: (mp, plugin, version) => join(root, "cache", mp, plugin, version),
    pluginDataDir: (plugin) => join(root, "data", plugin),
  };
}

// ============================== known_marketplaces.json ==============================

export const KnownMarketplaceRecordSchema = z
  .object({ source: MarketplaceSourceSchema, addedAt: z.string().optional() })
  .passthrough();
export const KnownMarketplacesFileSchema = z.record(KnownMarketplaceRecordSchema);
export type KnownMarketplaces = z.infer<typeof KnownMarketplacesFileSchema>;

export function readKnownMarketplaces(paths: PluginPaths): KnownMarketplaces {
  if (!existsSync(paths.knownMarketplacesFile)) return {};
  try {
    const raw = JSON.parse(readFileSync(paths.knownMarketplacesFile, "utf-8"));
    const parsed = KnownMarketplacesFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeKnownMarketplaces(paths: PluginPaths, data: KnownMarketplaces): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.knownMarketplacesFile, `${JSON.stringify(data, null, 2)}\n`);
}

/** 添加 / 覆盖一个 marketplace 记录。now 注入便于测试。 */
export function upsertKnownMarketplace(
  paths: PluginPaths,
  name: string,
  source: MarketplaceSource,
  now: Date = new Date(),
): void {
  const data = readKnownMarketplaces(paths);
  data[name] = { source, addedAt: now.toISOString() };
  writeKnownMarketplaces(paths, data);
}

export function removeKnownMarketplace(paths: PluginPaths, name: string): boolean {
  const data = readKnownMarketplaces(paths);
  if (!(name in data)) return false;
  delete data[name];
  writeKnownMarketplaces(paths, data);
  return true;
}

// ============================== version 管理 ==============================

/** 列出某 plugin 已缓存的 version 目录名(无则空)。 */
export function listPluginVersions(paths: PluginPaths, mp: string, plugin: string): string[] {
  const dir = join(paths.cacheDir, mp, plugin);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((v) => {
      try {
        return statSync(join(dir, v)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * 清理旧版本:删掉 != keep 且 mtime 早于 (now - graceMs) 的 version 目录。
 * 返回被删的 version 名列表。now / graceMs 注入便于测试。
 */
export function pruneOldVersions(
  paths: PluginPaths,
  mp: string,
  plugin: string,
  opts: { keep: string; graceMs: number; now?: number },
): string[] {
  const now = opts.now ?? Date.now();
  const dir = join(paths.cacheDir, mp, plugin);
  const removed: string[] = [];
  for (const v of listPluginVersions(paths, mp, plugin)) {
    if (v === opts.keep) continue;
    const vdir = join(dir, v);
    let mtime = 0;
    try {
      mtime = statSync(vdir).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime >= opts.graceMs) {
      try {
        rmSync(vdir, { recursive: true, force: true });
        removed.push(v);
      } catch {
        // ignore
      }
    }
  }
  return removed;
}
