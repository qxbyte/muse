/**
 * Plugin loader 端到端测试(从 cache 加载本地 plugin → 注入各 registry)。
 *
 * 设计文档:模块设计/Plugins/设计.md §七。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnabledPlugins, parsePluginKey } from "../src/plugins/loader.js";
import { createPluginPaths } from "../src/plugins/cache.js";
import type { PluginLogger } from "../src/plugins/types.js";

const silent: PluginLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

let root: string;
let paths: ReturnType<typeof createPluginPaths>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muse-ploader-"));
  paths = createPluginPaths(join(root, "plugins"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

/** 在 cache 造一个 plugin(deploy@acme v1.0.0)。返回 versionDir。 */
function mkPlugin(opts: { manifest?: object; skill?: boolean; mcp?: boolean; hooks?: boolean } = {}): string {
  const dir = paths.pluginCacheDir("acme", "deploy", "1.0.0");
  mkdirSync(join(dir, ".muse-plugin"), { recursive: true });
  const manifest = opts.manifest ?? {
    apiVersion: "1",
    name: "deploy",
    version: "1.0.0",
    ...(opts.mcp ? { mcpServers: "./.mcp.json" } : {}),
    ...(opts.hooks ? { hooks: "./hooks/hooks.json" } : {}),
  };
  writeFileSync(join(dir, ".muse-plugin", "plugin.json"), JSON.stringify(manifest));
  if (opts.skill) {
    mkdirSync(join(dir, "skills", "ship"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "ship", "SKILL.md"),
      `---\nname: ship\ndescription: ship to prod, ten plus chars\n---\nbody of ship`,
    );
  }
  if (opts.mcp) {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { db: { command: "${MUSE_PLUGIN_ROOT}/bin/db" } } }),
    );
  }
  if (opts.hooks) {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ PreToolUse: [{ command: "/usr/bin/true" }] }));
  }
  return dir;
}

function run(enabled: Record<string, boolean>) {
  return loadEnabledPlugins({ enabledPlugins: enabled, cwd: "/proj", logger: silent, paths });
}

describe("parsePluginKey", () => {
  it("<plugin>@<mp>", () => {
    expect(parsePluginKey("deploy@acme")).toEqual({ plugin: "deploy", marketplace: "acme" });
  });
  it("非法 → 抛错", () => {
    expect(() => parsePluginKey("deploy")).toThrow();
    expect(() => parsePluginKey("@acme")).toThrow();
  });
});

describe("loadEnabledPlugins", () => {
  it("加载本地 plugin:skills/mcp/hooks 全注入", async () => {
    mkPlugin({ skill: true, mcp: true, hooks: true });
    const { contributions, result } = await run({ "deploy@acme": true });
    expect(result.loaded).toContain("deploy@acme");
    expect(result.errors).toEqual([]);
    // skill(scope=plugin + pluginName)
    expect(contributions.skills).toHaveLength(1);
    expect(contributions.skills[0]).toMatchObject({ name: "ship", scope: "plugin", pluginName: "deploy" });
    // mcp(namespaced key + 路径变量替换)
    expect(contributions.mcpServers["deploy.db"]).toBeDefined();
    expect((contributions.mcpServers["deploy.db"] as { command: string }).command).toContain("/cache/acme/deploy/1.0.0/bin/db");
    expect((contributions.mcpServers["deploy.db"] as { command: string }).command).not.toContain("${MUSE_PLUGIN_ROOT}");
    // hooks
    expect(contributions.hooks.PreToolUse).toHaveLength(1);
  });

  it("enabled=false 跳过", async () => {
    mkPlugin({ skill: true });
    const { result, contributions } = await run({ "deploy@acme": false });
    expect(result.loaded).toEqual([]);
    expect(contributions.skills).toEqual([]);
  });

  it("未安装(cache 无)→ error 不阻塞", async () => {
    const { result } = await run({ "ghost@acme": true });
    expect(result.loaded).toEqual([]);
    expect(result.errors[0].reason).toMatch(/not installed/);
  });

  it("apiVersion 不兼容 → error", async () => {
    mkPlugin({ manifest: { apiVersion: "999", name: "deploy" }, skill: true });
    const { result, contributions } = await run({ "deploy@acme": true });
    expect(result.errors[0].reason).toMatch(/incompatible/);
    expect(contributions.skills).toEqual([]);
  });

  it("无 manifest → 按目录约定加载 skills", async () => {
    // 只造 skills,无 plugin.json
    const dir = paths.pluginCacheDir("acme", "deploy", "1.0.0");
    mkdirSync(join(dir, "skills", "ship"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "ship", "SKILL.md"),
      `---\nname: ship\ndescription: ship to prod, ten plus chars\n---\nbody`,
    );
    const { result, contributions } = await run({ "deploy@acme": true });
    expect(result.loaded).toContain("deploy@acme");
    expect(contributions.skills).toHaveLength(1);
  });

  it("main register 收集 slash(带 <plugin>: 前缀)", async () => {
    const dir = paths.pluginCacheDir("acme", "deploy", "1.0.0");
    mkdirSync(join(dir, ".muse-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".muse-plugin", "plugin.json"),
      JSON.stringify({ apiVersion: "1", name: "deploy", main: "./register.mjs" }),
    );
    writeFileSync(
      join(dir, "register.mjs"),
      `export default function register(ctx) { ctx.registerSlash({ name: "ship", description: "x", execute: () => ({ display: "ok" }) }); }`,
    );
    const { result, contributions } = await run({ "deploy@acme": true });
    expect(result.loaded).toContain("deploy@acme");
    expect(contributions.slash.map((c) => c.name)).toContain("deploy:ship"); // <plugin>: 前缀
  });
});
