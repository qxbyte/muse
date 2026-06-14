/**
 * gitClone 真实验证:用本地 git repo 作源(无网络),覆盖 PI-4 的 git 路径。
 *
 * 设计文档:模块设计/Plugins/设计.md §五.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { gitClone, fetchMarketplace } from "../src/plugins/fetch.js";

let base: string;
let repo: string;

/** 在 repo 目录初始化一个 git 仓库并提交一个 marketplace.json。 */
function initRepo(dir: string) {
  mkdirSync(join(dir, ".muse-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".muse-plugin", "marketplace.json"),
    JSON.stringify({ name: "acme", owner: { name: "Acme" }, plugins: [] }),
  );
  const opt = { cwd: dir, stdio: "pipe" as const };
  execaSync("git", ["init", "-q"], opt);
  execaSync("git", ["config", "user.email", "t@t.com"], opt);
  execaSync("git", ["config", "user.name", "t"], opt);
  execaSync("git", ["add", "."], opt);
  execaSync("git", ["commit", "-q", "-m", "init"], opt);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "muse-git-"));
  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  initRepo(repo);
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("gitClone(本地 repo)", () => {
  it("clone 出工作树内容", async () => {
    const dest = join(base, "clone");
    await gitClone(repo, dest);
    expect(existsSync(join(dest, ".muse-plugin", "marketplace.json"))).toBe(true);
    const m = JSON.parse(readFileSync(join(dest, ".muse-plugin", "marketplace.json"), "utf-8"));
    expect(m.name).toBe("acme");
  });

  it("fetchMarketplace(url source)走 gitClone", async () => {
    const dest = join(base, "mp");
    await fetchMarketplace({ source: "url", url: repo }, dest);
    expect(existsSync(join(dest, ".muse-plugin", "marketplace.json"))).toBe(true);
  });
});
