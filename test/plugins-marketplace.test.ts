/**
 * marketplace.json + source 解析测试。
 *
 * 设计文档:模块设计/Plugins/设计.md §四。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseMarketplaceManifest,
  loadMarketplaceManifest,
  findPluginEntry,
  normalizeMarketplaceSource,
  resolveInlinePluginDir,
  MARKETPLACE_MANIFEST_REL,
} from "../src/plugins/marketplace.js";

describe("parseMarketplaceManifest", () => {
  const valid = {
    name: "acme",
    owner: { name: "Acme" },
    plugins: [{ name: "deploy", source: "./plugins/deploy" }],
  };
  it("接受合法 manifest(对象或字符串)", () => {
    expect(parseMarketplaceManifest(valid).name).toBe("acme");
    expect(parseMarketplaceManifest(JSON.stringify(valid)).name).toBe("acme");
  });
  it("非法 → 抛错带原因", () => {
    expect(() => parseMarketplaceManifest({ name: "acme" })).toThrow(/invalid marketplace/);
  });
});

describe("findPluginEntry", () => {
  it("按名找条目", () => {
    const m = parseMarketplaceManifest({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "a", source: "./a" }, { name: "b", source: "./b" }],
    });
    expect(findPluginEntry(m, "b")?.source).toBe("./b");
    expect(findPluginEntry(m, "z")).toBeUndefined();
  });
});

describe("normalizeMarketplaceSource", () => {
  it("owner/repo → github", () => {
    expect(normalizeMarketplaceSource("acme/plugins")).toEqual({ source: "github", repo: "acme/plugins" });
  });
  it("owner/repo@ref → github + ref", () => {
    expect(normalizeMarketplaceSource("acme/plugins@v2")).toEqual({ source: "github", repo: "acme/plugins", ref: "v2" });
  });
  it("git url → url", () => {
    expect(normalizeMarketplaceSource("https://gitlab.com/t/p.git")).toEqual({ source: "url", url: "https://gitlab.com/t/p.git" });
  });
  it("git url#ref → url + ref", () => {
    expect(normalizeMarketplaceSource("https://x.com/p.git#main")).toEqual({ source: "url", url: "https://x.com/p.git", ref: "main" });
  });
  it("./path → local", () => {
    expect(normalizeMarketplaceSource("./my-mp")).toEqual({ source: "local", path: "./my-mp" });
  });
  it("对象原样返回", () => {
    const obj = { source: "github" as const, repo: "a/b" };
    expect(normalizeMarketplaceSource(obj)).toBe(obj);
  });
  it("无法解析 → 抛错", () => {
    expect(() => normalizeMarketplaceSource("not a source!!")).toThrow(/cannot resolve/);
  });
});

describe("loadMarketplaceManifest + resolveInlinePluginDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-mp-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function writeManifest(obj: unknown) {
    mkdirSync(join(dir, ".muse-plugin"), { recursive: true });
    writeFileSync(join(dir, MARKETPLACE_MANIFEST_REL), JSON.stringify(obj));
  }

  it("从目录读取 marketplace.json", () => {
    writeManifest({ name: "acme", owner: { name: "Acme" }, plugins: [{ name: "deploy", source: "./plugins/deploy" }] });
    const m = loadMarketplaceManifest(dir);
    expect(m.name).toBe("acme");
  });

  it("不存在 → 抛错", () => {
    expect(() => loadMarketplaceManifest(dir)).toThrow(/not found/);
  });

  it("内联相对 source → 解析为绝对路径(尊重 pluginRoot)", () => {
    const m = parseMarketplaceManifest({
      name: "acme",
      owner: { name: "Acme" },
      metadata: { pluginRoot: "./plugins" },
      plugins: [{ name: "deploy", source: "./deploy" }],
    });
    const resolved = resolveInlinePluginDir(m, m.plugins[0], dir);
    expect(resolved).toBe(resolve(dir, "plugins", "deploy"));
  });

  it("非内联(github)source → null(留 fetch)", () => {
    const m = parseMarketplaceManifest({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "gh", source: { source: "github", repo: "a/b" } }],
    });
    expect(resolveInlinePluginDir(m, m.plugins[0], dir)).toBeNull();
  });
});
