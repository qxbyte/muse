/**
 * Plugins v0.4 schema 测试。
 *
 * 设计文档:模块设计/Plugins/设计.md §三/§四/§六。
 */

import { describe, it, expect } from "vitest";
import {
  PLUGIN_API_VERSION,
  ExtraKnownMarketplacesSchema,
  EnabledPluginsSchema,
  MarketplaceSourceSchema,
  PluginSourceSchema,
  MarketplaceManifestSchema,
  PluginManifestSchema,
} from "../src/plugins/index.js";
import { SettingsSchema } from "../src/config/types.js";

describe("PLUGIN_API_VERSION", () => {
  it('当前为 "1"', () => {
    expect(PLUGIN_API_VERSION).toBe("1");
  });
});

describe("MarketplaceSourceSchema", () => {
  it("接受字符串简写(owner/repo)", () => {
    expect(MarketplaceSourceSchema.parse("acme/plugins")).toBe("acme/plugins");
  });
  it("接受显式对象(github/local/url)", () => {
    expect(MarketplaceSourceSchema.parse({ source: "github", repo: "acme/plugins", ref: "main" }))
      .toMatchObject({ source: "github", repo: "acme/plugins" });
    expect(MarketplaceSourceSchema.parse({ source: "local", path: "./mp" })).toMatchObject({ source: "local" });
  });
  it("非法 source 枚举 → 报错", () => {
    expect(() => MarketplaceSourceSchema.parse({ source: "ftp" })).toThrow();
  });
});

describe("settings extraKnownMarketplaces / enabledPlugins", () => {
  it("extraKnownMarketplaces 接受 name→source", () => {
    const m = ExtraKnownMarketplacesSchema.parse({
      acme: { source: { source: "github", repo: "acme/plugins" } },
    });
    expect(m.acme.source).toMatchObject({ source: "github" });
  });
  it("enabledPlugins 是 <plugin>@<mp> → bool", () => {
    const e = EnabledPluginsSchema.parse({ "deploy@acme": true, "x@acme": false });
    expect(e["deploy@acme"]).toBe(true);
    expect(e["x@acme"]).toBe(false);
  });
  it("SettingsSchema 接受两字段", () => {
    const s = SettingsSchema.parse({
      extraKnownMarketplaces: { acme: { source: "acme/plugins" } },
      enabledPlugins: { "deploy@acme": true },
    });
    expect(s.enabledPlugins?.["deploy@acme"]).toBe(true);
    expect(s.extraKnownMarketplaces?.acme.source).toBe("acme/plugins");
  });
  it("两字段可省(向后兼容)", () => {
    const s = SettingsSchema.parse({});
    expect(s.extraKnownMarketplaces).toBeUndefined();
    expect(s.enabledPlugins).toBeUndefined();
  });
});

describe("MarketplaceManifestSchema", () => {
  it("接受最小 marketplace(name/owner/plugins)", () => {
    const m = MarketplaceManifestSchema.parse({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "deploy", source: "./plugins/deploy" }],
    });
    expect(m.plugins[0].name).toBe("deploy");
  });
  it("plugin 条目支持 github source", () => {
    const m = MarketplaceManifestSchema.parse({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "gh", source: { source: "github", repo: "acme/gh" } }],
    });
    expect(m.plugins[0].source).toMatchObject({ source: "github" });
  });
  it("name 非 kebab → 报错", () => {
    expect(() =>
      MarketplaceManifestSchema.parse({ name: "Acme Tools", owner: { name: "x" }, plugins: [] }),
    ).toThrow();
  });
  it("缺 owner → 报错", () => {
    expect(() => MarketplaceManifestSchema.parse({ name: "acme", plugins: [] })).toThrow();
  });
});

describe("PluginSourceSchema", () => {
  it("相对路径字符串", () => {
    expect(PluginSourceSchema.parse("./plugins/x")).toBe("./plugins/x");
  });
  it("github 对象", () => {
    expect(PluginSourceSchema.parse({ source: "github", repo: "a/b", sha: "abc" })).toMatchObject({ sha: "abc" });
  });
});

describe("PluginManifestSchema", () => {
  it("最小 manifest(只需 apiVersion)", () => {
    expect(PluginManifestSchema.parse({ apiVersion: "1" }).apiVersion).toBe("1");
  });
  it("完整 manifest", () => {
    const m = PluginManifestSchema.parse({
      apiVersion: "1",
      name: "deploy-suite",
      version: "1.2.0",
      author: { name: "Acme", email: "x@acme.com" },
      skills: ["./skills"],
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
      main: "./dist/plugin.js",
    });
    expect(m.name).toBe("deploy-suite");
    expect(m.skills).toEqual(["./skills"]);
  });
  it("name 非 kebab → 报错", () => {
    expect(() => PluginManifestSchema.parse({ apiVersion: "1", name: "Deploy Suite" })).toThrow();
  });
  it("缺 apiVersion → 报错", () => {
    expect(() => PluginManifestSchema.parse({ name: "x" })).toThrow();
  });
});
