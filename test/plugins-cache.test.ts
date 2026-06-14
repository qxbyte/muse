/**
 * Plugin 缓存布局 + known_marketplaces 读写测试。
 *
 * 设计文档:模块设计/Plugins/设计.md §五。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginPaths,
  readKnownMarketplaces,
  writeKnownMarketplaces,
  upsertKnownMarketplace,
  removeKnownMarketplace,
  listPluginVersions,
  pruneOldVersions,
} from "../src/plugins/cache.js";

let root: string;
let paths: ReturnType<typeof createPluginPaths>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muse-pcache-"));
  paths = createPluginPaths(root);
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("createPluginPaths", () => {
  it("布局路径正确", () => {
    expect(paths.marketplacesDir).toBe(join(root, "marketplaces"));
    expect(paths.cacheDir).toBe(join(root, "cache"));
    expect(paths.marketplaceDir("acme")).toBe(join(root, "marketplaces", "acme"));
    expect(paths.pluginCacheDir("acme", "deploy", "1.0.0")).toBe(join(root, "cache", "acme", "deploy", "1.0.0"));
    expect(paths.pluginDataDir("deploy")).toBe(join(root, "data", "deploy"));
  });
});

describe("known_marketplaces 读写", () => {
  it("不存在 → 空对象", () => {
    expect(readKnownMarketplaces(paths)).toEqual({});
  });

  it("write → read round-trip", () => {
    writeKnownMarketplaces(paths, { acme: { source: "acme/plugins" } });
    expect(readKnownMarketplaces(paths).acme.source).toBe("acme/plugins");
  });

  it("upsert 添加 + addedAt", () => {
    upsertKnownMarketplace(paths, "acme", { source: "github", repo: "acme/plugins" }, new Date("2026-06-14T00:00:00Z"));
    const data = readKnownMarketplaces(paths);
    expect(data.acme.source).toMatchObject({ source: "github" });
    expect(data.acme.addedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  it("remove 删除", () => {
    upsertKnownMarketplace(paths, "acme", "acme/plugins");
    expect(removeKnownMarketplace(paths, "acme")).toBe(true);
    expect(readKnownMarketplaces(paths).acme).toBeUndefined();
    expect(removeKnownMarketplace(paths, "nope")).toBe(false);
  });

  it("损坏 JSON → 容错返回空", () => {
    writeKnownMarketplaces(paths, {});
    writeFileSync(paths.knownMarketplacesFile, "{ not json"); // 手动写坏
    expect(readKnownMarketplaces(paths)).toEqual({});
  });
});

describe("version 管理", () => {
  function mkVersion(mp: string, plugin: string, v: string, mtime?: Date) {
    const dir = paths.pluginCacheDir(mp, plugin, v);
    mkdirSync(dir, { recursive: true });
    if (mtime) utimesSync(dir, mtime, mtime);
    return dir;
  }

  it("listPluginVersions 列出版本目录", () => {
    mkVersion("acme", "deploy", "1.0.0");
    mkVersion("acme", "deploy", "1.1.0");
    expect(listPluginVersions(paths, "acme", "deploy").sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  it("无缓存 → 空", () => {
    expect(listPluginVersions(paths, "acme", "nope")).toEqual([]);
  });

  it("pruneOldVersions 删旧留 keep", () => {
    const now = Date.now();
    mkVersion("acme", "deploy", "1.0.0", new Date(now - 30 * 86400_000)); // 30 天前
    mkVersion("acme", "deploy", "1.1.0", new Date(now - 30 * 86400_000)); // 30 天前(但 keep)
    mkVersion("acme", "deploy", "0.9.0", new Date(now - 1 * 86400_000)); // 1 天前(未过期)
    const removed = pruneOldVersions(paths, "acme", "deploy", { keep: "1.1.0", graceMs: 7 * 86400_000, now });
    expect(removed).toEqual(["1.0.0"]); // 只有 1.0.0 既非 keep 又过期
    expect(existsSync(paths.pluginCacheDir("acme", "deploy", "1.1.0"))).toBe(true);
    expect(existsSync(paths.pluginCacheDir("acme", "deploy", "0.9.0"))).toBe(true);
    expect(existsSync(paths.pluginCacheDir("acme", "deploy", "1.0.0"))).toBe(false);
  });
});
