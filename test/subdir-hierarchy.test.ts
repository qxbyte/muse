/**
 * II-1.3 子目录惰性加载 helper 测试。
 *
 * 集成测试(Agent loop + mock LLM + 真工具)留下次;本期覆盖 helper 函数的逻辑正确性。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractToolPath,
  findContainingSubdirWithHierarchy,
} from "../src/loop/agent.js";

describe("II-1.3 — extractToolPath", () => {
  it("Read 提 file_path", () => {
    expect(extractToolPath("Read", { file_path: "/a/b/c.ts" })).toBe("/a/b/c.ts");
  });

  it("Edit 提 file_path", () => {
    expect(extractToolPath("Edit", { file_path: "/a/b/c.ts", old_string: "x", new_string: "y" })).toBe("/a/b/c.ts");
  });

  it("Write 提 file_path", () => {
    expect(extractToolPath("Write", { file_path: "/a/b/c.ts", content: "..." })).toBe("/a/b/c.ts");
  });

  it("Grep 提 path", () => {
    expect(extractToolPath("Grep", { pattern: "foo", path: "/src" })).toBe("/src");
  });

  it("Glob 提 path", () => {
    expect(extractToolPath("Glob", { pattern: "*.ts", path: "/src" })).toBe("/src");
  });

  it("Bash 不提路径(命令字符串不可靠)", () => {
    expect(extractToolPath("Bash", { command: "ls /tmp" })).toBeNull();
  });

  it("未知工具返 null", () => {
    expect(extractToolPath("Unknown", { file_path: "/a" })).toBeNull();
  });

  it("缺 file_path 返 null", () => {
    expect(extractToolPath("Read", { other: "x" })).toBeNull();
  });

  it("非 object args 返 null", () => {
    expect(extractToolPath("Read", null)).toBeNull();
    expect(extractToolPath("Read", "string")).toBeNull();
  });
});

describe("II-1.3 — findContainingSubdirWithHierarchy", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "muse-subdir-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("路径在 subdir 内,subdir 有 MUSE.md → 返回 subdir 路径", async () => {
    const src = join(projectRoot, "src");
    await mkdir(src);
    await writeFile(join(src, "MUSE.md"), "subdir guidance", "utf-8");
    const absPath = join(src, "foo.ts");
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBe(src);
  });

  it("路径在 subdir 内,subdir 有 AGENTS.md(无 MUSE.md)→ 返回 subdir 路径", async () => {
    const src = join(projectRoot, "src");
    await mkdir(src);
    await writeFile(join(src, "AGENTS.md"), "agents", "utf-8");
    const absPath = join(src, "foo.ts");
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBe(src);
  });

  it("多层嵌套时向上找最近的含 MUSE.md 的目录", async () => {
    const src = join(projectRoot, "src");
    const components = join(src, "components");
    await mkdir(components, { recursive: true });
    // 只 src 含 MUSE.md;components 不含
    await writeFile(join(src, "MUSE.md"), "src guidance", "utf-8");
    const absPath = join(components, "Foo.tsx");
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBe(src);
  });

  it("多层嵌套时,优先返回最深的含 MUSE.md 的目录", async () => {
    const src = join(projectRoot, "src");
    const components = join(src, "components");
    await mkdir(components, { recursive: true });
    await writeFile(join(src, "MUSE.md"), "src", "utf-8");
    await writeFile(join(components, "MUSE.md"), "components", "utf-8");
    const absPath = join(components, "Foo.tsx");
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBe(components);
  });

  it("subdir 无 MUSE.md/AGENTS.md → 返回 null", async () => {
    const src = join(projectRoot, "src");
    await mkdir(src);
    const absPath = join(src, "foo.ts");
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBeNull();
  });

  it("路径在 projectRoot 直接下(无子目录)→ 返回 null", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "root", "utf-8");
    const absPath = join(projectRoot, "package.json");
    // 路径直接在 root 下,dirname = root,跳过(因为 root 的 MUSE.md 已被启动 hierarchy 加载)
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBeNull();
  });

  it("路径不在 projectRoot 下 → 返回 null", async () => {
    const absPath = "/tmp/outside.ts";
    expect(findContainingSubdirWithHierarchy(absPath, projectRoot)).toBeNull();
  });

  it("路径等于 projectRoot 时 → 返回 null", () => {
    expect(findContainingSubdirWithHierarchy(projectRoot, projectRoot)).toBeNull();
  });
});
