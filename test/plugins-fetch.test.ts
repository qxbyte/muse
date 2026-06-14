/**
 * plugin fetch(local 复制)测试。git clone 路径靠集成/人工验证。
 *
 * 设计文档:模块设计/Plugins/设计.md §五。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDir, fetchMarketplace, fetchPlugin } from "../src/plugins/fetch.js";
import { parseMarketplaceManifest } from "../src/plugins/marketplace.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "muse-fetch-"));
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("copyDir", () => {
  it("递归复制 + 先清空 dest", () => {
    const src = join(base, "src");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "A");
    writeFileSync(join(src, "sub", "b.txt"), "B");
    const dest = join(base, "dest");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale.txt"), "old");
    copyDir(src, dest);
    expect(readFileSync(join(dest, "a.txt"), "utf-8")).toBe("A");
    expect(readFileSync(join(dest, "sub", "b.txt"), "utf-8")).toBe("B");
    expect(existsSync(join(dest, "stale.txt"))).toBe(false); // 已清空
  });

  it("源不存在 → 抛错", () => {
    expect(() => copyDir(join(base, "nope"), join(base, "d"))).toThrow(/not found/);
  });
});

describe("fetchMarketplace (local)", () => {
  it("复制本地 marketplace 目录到 dest", async () => {
    const mp = join(base, "mp");
    mkdirSync(join(mp, ".muse-plugin"), { recursive: true });
    writeFileSync(join(mp, ".muse-plugin", "marketplace.json"), "{}");
    const dest = join(base, "cache", "mp");
    await fetchMarketplace({ source: "local", path: mp }, dest);
    expect(existsSync(join(dest, ".muse-plugin", "marketplace.json"))).toBe(true);
  });

  it("字符串 source(未规范化)→ 抛错", async () => {
    await expect(fetchMarketplace("acme/x" as never, join(base, "d"))).rejects.toThrow(/normalized/);
  });
});

describe("fetchPlugin (inline local)", () => {
  it("从 marketplace clone 复制内联 plugin 到版本目录", async () => {
    // 造一个 marketplace clone,内含 plugins/deploy
    const mpDir = join(base, "mp");
    const pluginSrc = join(mpDir, "plugins", "deploy");
    mkdirSync(join(pluginSrc, ".muse-plugin"), { recursive: true });
    writeFileSync(join(pluginSrc, ".muse-plugin", "plugin.json"), JSON.stringify({ apiVersion: "1", name: "deploy" }));
    const manifest = parseMarketplaceManifest({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "deploy", source: "./plugins/deploy" }],
    });
    const dest = join(base, "cache", "acme", "deploy", "1.0.0");
    await fetchPlugin({ entry: manifest.plugins[0], manifest, marketplaceDir: mpDir, destVersionDir: dest });
    const m = JSON.parse(readFileSync(join(dest, ".muse-plugin", "plugin.json"), "utf-8"));
    expect(m.name).toBe("deploy");
  });

  it("内联源不存在 → 抛错", async () => {
    const manifest = parseMarketplaceManifest({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [{ name: "x", source: "./missing" }],
    });
    await expect(
      fetchPlugin({ entry: manifest.plugins[0], manifest, marketplaceDir: base, destVersionDir: join(base, "d") }),
    ).rejects.toThrow(/not found/);
  });
});
