/**
 * Plugins 端到端:本地 marketplace → add → install → loader 加载 → contributions 生效。
 *
 * 设计文档:模块设计/Plugins/设计.md §九.
 * 串起 manage(安装)+ loader(启动期加载),验证完整闭环。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginPaths } from "../src/plugins/cache.js";
import { addMarketplace, installPlugin } from "../src/plugins/manage.js";
import { loadEnabledPlugins } from "../src/plugins/loader.js";
import type { PluginLogger } from "../src/plugins/types.js";

const silent: PluginLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

let base: string;
let paths: ReturnType<typeof createPluginPaths>;
let settingsPath: string;
let mpSrc: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "muse-pe2e-"));
  paths = createPluginPaths(join(base, "plugins"));
  settingsPath = join(base, "settings.json");
  // 本地 marketplace,内联 plugin "deploy":skills + .mcp.json + hooks + main register
  mpSrc = join(base, "mp-src");
  const pdir = join(mpSrc, "plugins", "deploy");
  mkdirSync(join(mpSrc, ".muse-plugin"), { recursive: true });
  writeFileSync(
    join(mpSrc, ".muse-plugin", "marketplace.json"),
    JSON.stringify({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "deploy", source: "./plugins/deploy", version: "1.0.0" }],
    }),
  );
  mkdirSync(join(pdir, ".muse-plugin"), { recursive: true });
  writeFileSync(
    join(pdir, ".muse-plugin", "plugin.json"),
    JSON.stringify({
      apiVersion: "1",
      name: "deploy",
      version: "1.0.0",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
      main: "./register.mjs",
    }),
  );
  mkdirSync(join(pdir, "skills", "ship"), { recursive: true });
  writeFileSync(join(pdir, "skills", "ship", "SKILL.md"), `---\nname: ship\ndescription: ship to prod, ten plus chars\n---\nbody`);
  writeFileSync(join(pdir, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "${MUSE_PLUGIN_ROOT}/bin/db" } } }));
  mkdirSync(join(pdir, "hooks"), { recursive: true });
  writeFileSync(join(pdir, "hooks", "hooks.json"), JSON.stringify({ PreToolUse: [{ command: "/usr/bin/true" }] }));
  writeFileSync(
    join(pdir, "register.mjs"),
    `export default function register(ctx){ ctx.registerSlash({ name: "ship", description: "x", execute: () => ({ display: "ok" }) }); }`,
  );
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("Plugins 端到端(本地 marketplace)", () => {
  it("add → install → loader 全链生效", async () => {
    // 1. 添加 marketplace
    const addRes = await addMarketplace({ source: mpSrc, paths, settingsPath });
    expect(addRes).toEqual({ name: "acme", pluginCount: 1 });

    // 2. 安装 plugin
    await installPlugin({ key: "deploy@acme", paths, settingsPath });

    // 3. 读回 settings.enabledPlugins(模拟重启后 cli 读 settings)
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.enabledPlugins["deploy@acme"]).toBe(true);
    expect(settings.extraKnownMarketplaces.acme).toBeDefined();

    // 4. loader 按 enabledPlugins 加载(模拟 cli.tsx 启动期)
    const { contributions, result } = await loadEnabledPlugins({
      enabledPlugins: settings.enabledPlugins,
      cwd: base,
      logger: silent,
      paths,
    });

    expect(result.loaded).toEqual(["deploy@acme"]);
    expect(result.errors).toEqual([]);
    // skill(plugin 层 + namespace)
    expect(contributions.skills.map((s) => s.name)).toContain("ship");
    expect(contributions.skills[0].scope).toBe("plugin");
    expect(contributions.skills[0].pluginName).toBe("deploy");
    // mcp(namespaced + 路径变量替换到真实 cache 目录)
    const db = contributions.mcpServers["deploy.db"] as { command: string };
    expect(db.command).toContain(paths.pluginCacheDir("acme", "deploy", "1.0.0"));
    expect(db.command).not.toContain("${MUSE_PLUGIN_ROOT}");
    // hooks
    expect(contributions.hooks.PreToolUse).toHaveLength(1);
    // main register → slash(<plugin>: 前缀)
    expect(contributions.slash.map((c) => c.name)).toContain("deploy:ship");
  });

  it("uninstall 后 loader 不再加载", async () => {
    await addMarketplace({ source: mpSrc, paths, settingsPath });
    await installPlugin({ key: "deploy@acme", paths, settingsPath });
    // 模拟 disable
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.enabledPlugins["deploy@acme"] = false;
    const { contributions, result } = await loadEnabledPlugins({
      enabledPlugins: settings.enabledPlugins,
      cwd: base,
      logger: silent,
      paths,
    });
    expect(result.loaded).toEqual([]);
    expect(contributions.skills).toEqual([]);
    expect(existsSync(paths.pluginCacheDir("acme", "deploy", "1.0.0"))).toBe(true); // 缓存仍在
  });
});
