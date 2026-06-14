/**
 * Plugins P1 骨架 schema 测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §六。
 * 本期只验证 schema 契约(loader / activationEvents 引擎留 v0.4)。
 */

import { describe, it, expect } from "vitest";
import {
  PLUGIN_API_VERSION,
  PluginsConfigSchema,
  PluginManifestSchema,
} from "../src/plugins/index.js";
import { SettingsSchema } from "../src/config/types.js";

describe("PLUGIN_API_VERSION", () => {
  it("当前为 \"1\"", () => {
    expect(PLUGIN_API_VERSION).toBe("1");
  });
});

describe("PluginsConfigSchema", () => {
  it("接受 enabled 列表", () => {
    const cfg = PluginsConfigSchema.parse({ enabled: ["@author/muse-plugin-deploy"] });
    expect(cfg.enabled).toEqual(["@author/muse-plugin-deploy"]);
  });

  it("enabled 可省(全部可选)", () => {
    expect(PluginsConfigSchema.parse({})).toEqual({});
  });

  it("passthrough 保留未知字段(向前兼容 v0.4 新增字段)", () => {
    const cfg = PluginsConfigSchema.parse({ enabled: [], future: 1 }) as Record<string, unknown>;
    expect(cfg.future).toBe(1);
  });

  it("enabled 非字符串数组 → 报错", () => {
    expect(() => PluginsConfigSchema.parse({ enabled: [123] })).toThrow();
  });
});

describe("PluginManifestSchema", () => {
  it("接受最小 manifest(只需 apiVersion)", () => {
    const m = PluginManifestSchema.parse({ apiVersion: "1" });
    expect(m.apiVersion).toBe("1");
  });

  it("接受完整 manifest(对齐设计 §6.3)", () => {
    const m = PluginManifestSchema.parse({
      apiVersion: "1",
      main: "./dist/plugin.js",
      skills: ["./skills/*/SKILL.md"],
      mcpServers: { "deploy-helper": { command: "node", args: ["./dist/mcp-server.js"] } },
      activationEvents: ["onSkill:deploy-prod", "onSlash:deploy"],
    });
    expect(m.skills).toEqual(["./skills/*/SKILL.md"]);
    expect(m.activationEvents).toContain("onSkill:deploy-prod");
  });

  it("缺 apiVersion → 报错", () => {
    expect(() => PluginManifestSchema.parse({ main: "./x.js" })).toThrow();
  });
});

describe("SettingsSchema.plugins 接入", () => {
  it("settings 接受 plugins 字段", () => {
    const s = SettingsSchema.parse({ plugins: { enabled: ["@org/muse-plugin-x"] } });
    expect(s.plugins?.enabled).toEqual(["@org/muse-plugin-x"]);
  });

  it("plugins 可省(向后兼容旧 settings.json)", () => {
    const s = SettingsSchema.parse({});
    expect(s.plugins).toBeUndefined();
  });
});
