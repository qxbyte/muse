import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryAtCandidates, _clearAtCache } from "../../src/preprocess/input/at-source.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "muse-at-"));
  _clearAtCache();
  // 准备 fixture 文件
  mkdirSync(join(workdir, "src"), { recursive: true });
  mkdirSync(join(workdir, "src", "components"), { recursive: true });
  mkdirSync(join(workdir, "test"), { recursive: true });
  mkdirSync(join(workdir, "node_modules", "foo"), { recursive: true });
  mkdirSync(join(workdir, ".git"), { recursive: true });
  writeFileSync(join(workdir, "README.md"), "");
  writeFileSync(join(workdir, "LICENSE"), "");
  writeFileSync(join(workdir, "package.json"), "");
  writeFileSync(join(workdir, "src", "index.ts"), "");
  writeFileSync(join(workdir, "src", "app.tsx"), "");
  writeFileSync(join(workdir, "src", "components", "Button.tsx"), "");
  writeFileSync(join(workdir, "test", "foo.test.ts"), "");
  writeFileSync(join(workdir, "node_modules", "foo", "junk.js"), "");
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

describe("queryAtCandidates", () => {
  it("empty query lists shallowest entries first", async () => {
    const cands = await queryAtCandidates(workdir, "");
    expect(cands.length).toBeGreaterThan(0);
    // 浅层先来:src/ test/ README.md ...
    const first5 = cands.slice(0, 5).map((c) => c.rel);
    expect(first5).toContain("src");
    expect(first5).toContain("test");
    expect(first5).toContain("README.md");
  });

  it("excludes node_modules and .git by default", async () => {
    const cands = await queryAtCandidates(workdir, "");
    const rels = cands.map((c) => c.rel);
    expect(rels.find((r) => r.startsWith("node_modules"))).toBeUndefined();
    expect(rels.find((r) => r.startsWith(".git"))).toBeUndefined();
  });

  it("flat fuzzy match for query without /", async () => {
    const cands = await queryAtCandidates(workdir, "button");
    expect(cands[0]?.rel).toBe("src/components/Button.tsx");
  });

  it("dir traversal when query contains /", async () => {
    const cands = await queryAtCandidates(workdir, "src/");
    const rels = cands.map((c) => c.rel);
    expect(rels).toContain("src/index.ts");
    expect(rels).toContain("src/app.tsx");
    expect(rels).toContain("src/components");
  });

  it("dir traversal with leaf filter", async () => {
    const cands = await queryAtCandidates(workdir, "src/app");
    expect(cands[0]?.rel).toBe("src/app.tsx");
  });

  it("dir traversal — directories sorted before files", async () => {
    const cands = await queryAtCandidates(workdir, "src/");
    const componentsIdx = cands.findIndex((c) => c.rel === "src/components");
    const indexIdx = cands.findIndex((c) => c.rel === "src/index.ts");
    expect(componentsIdx).toBeLessThan(indexIdx);
  });

  it("isDir true for directories", async () => {
    const cands = await queryAtCandidates(workdir, "src/");
    const comp = cands.find((c) => c.rel === "src/components");
    expect(comp?.isDir).toBe(true);
    const idx = cands.find((c) => c.rel === "src/index.ts");
    expect(idx?.isDir).toBe(false);
  });

  it("base name starts-with beats other matches", async () => {
    writeFileSync(join(workdir, "foobar.txt"), "");
    writeFileSync(join(workdir, "barfoo.txt"), "");
    _clearAtCache();
    const cands = await queryAtCandidates(workdir, "foo");
    // foobar.txt starts with foo → 应排前
    expect(cands[0]?.rel).toBe("foobar.txt");
  });
});

describe("queryAtCandidates — @skill 候选(扩展接入口 §十)", () => {
  it("匹配的 skill 排在文件候选之前,kind=skill", async () => {
    const cands = await queryAtCandidates(workdir, "dep", ["deploy-prod", "migrate-db"]);
    expect(cands[0]).toMatchObject({ rel: "deploy-prod", kind: "skill", isDir: false });
  });

  it("空 query 列出全部 skill(置顶)", async () => {
    const cands = await queryAtCandidates(workdir, "", ["deploy-prod", "build"]);
    const skillRels = cands.filter((c) => c.kind === "skill").map((c) => c.rel);
    expect(skillRels).toEqual(expect.arrayContaining(["deploy-prod", "build"]));
    // skill 在最前
    expect(cands[0]?.kind).toBe("skill");
  });

  it("不传 skillNames → 无 skill 候选(行为同旧版)", async () => {
    const cands = await queryAtCandidates(workdir, "dep");
    expect(cands.find((c) => c.kind === "skill")).toBeUndefined();
  });

  it("query 含 / 时不出 skill 候选(skill 名无 /)", async () => {
    const cands = await queryAtCandidates(workdir, "src/", ["deploy-prod"]);
    expect(cands.find((c) => c.kind === "skill")).toBeUndefined();
  });

  it("不匹配的 skill 不出现", async () => {
    const cands = await queryAtCandidates(workdir, "zzz", ["deploy-prod"]);
    expect(cands.find((c) => c.kind === "skill")).toBeUndefined();
  });
});
