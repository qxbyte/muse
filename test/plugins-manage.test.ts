/**
 * Plugin 管理操作测试(/plugin 内核)— 本地 marketplace,注入 paths/settings。
 *
 * 设计文档:模块设计/Plugins/设计.md §九。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginPaths } from "../src/plugins/cache.js";
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  installPlugin,
  setPluginEnabled,
  uninstallPlugin,
  listPlugins,
  settingsPathForScope,
} from "../src/plugins/manage.js";

let base: string;
let paths: ReturnType<typeof createPluginPaths>;
let settingsPath: string;
let mpSrc: string; // 本地 marketplace 源

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "muse-pmanage-"));
  paths = createPluginPaths(join(base, "plugins"));
  settingsPath = join(base, "settings.json");
  // 造本地 marketplace:.muse-plugin/marketplace.json + 内联 plugin deploy
  mpSrc = join(base, "mp-src");
  mkdirSync(join(mpSrc, ".muse-plugin"), { recursive: true });
  writeFileSync(
    join(mpSrc, ".muse-plugin", "marketplace.json"),
    JSON.stringify({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "deploy", source: "./plugins/deploy", version: "1.0.0" }],
    }),
  );
  const pdir = join(mpSrc, "plugins", "deploy");
  mkdirSync(join(pdir, ".muse-plugin"), { recursive: true });
  writeFileSync(join(pdir, ".muse-plugin", "plugin.json"), JSON.stringify({ apiVersion: "1", name: "deploy", version: "1.0.0" }));
  mkdirSync(join(pdir, "skills", "ship"), { recursive: true });
  writeFileSync(join(pdir, "skills", "ship", "SKILL.md"), `---\nname: ship\ndescription: ship to prod ten plus\n---\nbody`);
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

function readSettings() {
  return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
}

describe("settingsPathForScope", () => {
  it("user / project / local", () => {
    expect(settingsPathForScope("user", { home: "/h", cwd: "/c" })).toBe("/h/.muse/settings.json");
    expect(settingsPathForScope("project", { cwd: "/c" })).toBe("/c/.muse/settings.json");
    expect(settingsPathForScope("local", { cwd: "/c" })).toBe("/c/.muse/settings.local.json");
  });
});

describe("marketplace 生命周期(本地源)", () => {
  it("add → known + settings + cache 安置", async () => {
    const r = await addMarketplace({ source: mpSrc, paths, settingsPath });
    expect(r).toEqual({ name: "acme", pluginCount: 1 });
    // cache 安置
    expect(existsSync(join(paths.marketplaceDir("acme"), ".muse-plugin", "marketplace.json"))).toBe(true);
    // known
    expect(listMarketplaces(paths).map((m) => m.name)).toContain("acme");
    // settings
    expect(readSettings().extraKnownMarketplaces.acme).toBeDefined();
  });

  it("remove → known + settings 清除", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    expect(removeMarketplace({ name: "acme", paths, settingsPath })).toBe(true);
    expect(listMarketplaces(paths)).toEqual([]);
    expect(readSettings().extraKnownMarketplaces.acme).toBeUndefined();
    expect(existsSync(paths.marketplaceDir("acme"))).toBe(false);
  });
});

describe("plugin 生命周期(本地内联)", () => {
  it("install → cache 版本目录 + enabledPlugins=true", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    const r = await installPlugin({ key: "deploy@acme", paths, settingsPath });
    expect(r).toEqual({ key: "deploy@acme", version: "1.0.0" });
    expect(existsSync(paths.pluginCacheDir("acme", "deploy", "1.0.0"))).toBe(true);
    expect(readSettings().enabledPlugins["deploy@acme"]).toBe(true);
  });

  it("install 未知 plugin → 抛错", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    await expect(installPlugin({ key: "ghost@acme", paths, settingsPath })).rejects.toThrow(/not found/);
  });

  it("install 到未添加的 marketplace → 抛错", async () => {
    await expect(installPlugin({ key: "deploy@nope", paths, settingsPath })).rejects.toThrow(/not added/);
  });

  it("enable / disable 切换 settings", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    await installPlugin({ key: "deploy@acme", paths, settingsPath });
    setPluginEnabled({ key: "deploy@acme", enabled: false, settingsPath });
    expect(readSettings().enabledPlugins["deploy@acme"]).toBe(false);
  });

  it("uninstall 清 enabledPlugins(+purge cache)", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    await installPlugin({ key: "deploy@acme", paths, settingsPath });
    uninstallPlugin({ key: "deploy@acme", paths, settingsPath, purgeCache: true });
    expect(readSettings().enabledPlugins["deploy@acme"]).toBeUndefined();
    expect(existsSync(join(paths.cacheDir, "acme", "deploy"))).toBe(false);
  });

  it("listPlugins 反映 enabled/installed 状态", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    await installPlugin({ key: "deploy@acme", paths, settingsPath });
    const items = listPlugins({ paths, enabledPlugins: readSettings().enabledPlugins });
    expect(items).toEqual([{ key: "deploy@acme", enabled: true, installed: true }]);
  });
});
