/**
 * memory scope(项目 / 全局)双层数据层测试。
 *
 * 覆盖:
 *   - writeMemory scope 默认 project / 显式 user
 *   - readMemory 不指定 scope 时 project 优先,fallback user
 *   - listMemories scope all / project / user
 *   - deleteMemory scope 自动定位
 *   - promoteScopeToUser:project → user
 *   - setMemoryTrust 跨 scope 寻址
 *   - 同名跨 scope 独立存储不互相干扰
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMemory,
  readMemory,
  listMemories,
  deleteMemory,
  promoteScopeToUser,
  setMemoryTrust,
  memoryDir,
  globalMemoryDir,
  memoryFilePath,
} from "../src/loop/memory.js";
import { existsSync } from "node:fs";

const FIXED_CWD = "/Users/test/scope-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-scope-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

describe("scope 数据层 — writeMemory", () => {
  it("默认 scope = project,写到项目目录", async () => {
    const result = await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    expect(result.scope).toBe("project");
    expect(result.filePath).toContain("/projects/");
    expect(existsSync(memoryFilePath(FIXED_CWD, "p1", "project"))).toBe(true);
    expect(existsSync(memoryFilePath(FIXED_CWD, "p1", "user"))).toBe(false);
  });

  it("scope=user 写到全局目录(~/.muse/memory/)", async () => {
    const result = await writeMemory(FIXED_CWD, { name: "u1", description: "d", type: "user", body: "b", scope: "user" });
    expect(result.scope).toBe("user");
    expect(result.filePath).toBe(memoryFilePath(FIXED_CWD, "u1", "user"));
    expect(result.filePath.startsWith(globalMemoryDir())).toBe(true);
    expect(existsSync(memoryFilePath(FIXED_CWD, "u1", "user"))).toBe(true);
    expect(existsSync(memoryFilePath(FIXED_CWD, "u1", "project"))).toBe(false);
  });

  it("两 scope 同名独立存储不互相覆盖", async () => {
    await writeMemory(FIXED_CWD, { name: "shared", description: "P", type: "user", body: "project body", scope: "project" });
    await writeMemory(FIXED_CWD, { name: "shared", description: "U", type: "user", body: "user body", scope: "user" });
    const p = await readMemory(FIXED_CWD, "shared", "project");
    const u = await readMemory(FIXED_CWD, "shared", "user");
    expect(p.body).toBe("project body");
    expect(u.body).toBe("user body");
    expect(p.frontmatter.description).toBe("P");
    expect(u.frontmatter.description).toBe("U");
  });
});

describe("scope 数据层 — readMemory fallback", () => {
  it("不指定 scope 时 project 优先", async () => {
    await writeMemory(FIXED_CWD, { name: "x", description: "user version", type: "user", body: "U", scope: "user" });
    await writeMemory(FIXED_CWD, { name: "x", description: "project version", type: "user", body: "P", scope: "project" });
    const file = await readMemory(FIXED_CWD, "x");
    expect(file.scope).toBe("project");
    expect(file.body).toBe("P");
  });

  it("不指定 scope + 只在 user 时 fallback 到 user", async () => {
    await writeMemory(FIXED_CWD, { name: "uonly", description: "u", type: "user", body: "b", scope: "user" });
    const file = await readMemory(FIXED_CWD, "uonly");
    expect(file.scope).toBe("user");
  });

  it("不指定 scope + 两 scope 都不在 → 抛错", async () => {
    await expect(readMemory(FIXED_CWD, "nope")).rejects.toThrow(/does not exist/);
  });

  it("scope 指定时只查该层,跨层不 fallback", async () => {
    await writeMemory(FIXED_CWD, { name: "u-only", description: "u", type: "user", body: "b", scope: "user" });
    await expect(readMemory(FIXED_CWD, "u-only", "project")).rejects.toThrow(/does not exist/);
  });
});

describe("scope 数据层 — listMemories", () => {
  it("scope=all(默认)合并两层", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "p1", type: "user", body: "b", scope: "project" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "u1", type: "user", body: "b", scope: "user" });
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(2);
    const names = list.map((m) => m.frontmatter.name).sort();
    expect(names).toEqual(["p1", "u1"]);
  });

  it("scope=project 只列项目层", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "p1", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "u1", type: "user", body: "b", scope: "user" });
    const list = await listMemories(FIXED_CWD, { scope: "project" });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.name).toBe("p1");
    expect(list[0].scope).toBe("project");
  });

  it("scope=user 只列全局层", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "p1", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "u1", type: "user", body: "b", scope: "user" });
    const list = await listMemories(FIXED_CWD, { scope: "user" });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.name).toBe("u1");
    expect(list[0].scope).toBe("user");
  });

  it("同名跨 scope 列表中各算一条,project 排前(tie-break)", async () => {
    await writeMemory(FIXED_CWD, { name: "shared", description: "p", type: "user", body: "b" });
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "shared", description: "u", type: "user", body: "b", scope: "user" });
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(2);
    // 同 trust + 不同 updated_at 时按 updated_at 降序(u 后写,排前)
    expect(list[0].scope).toBe("user");
    expect(list[1].scope).toBe("project");
  });
});

describe("scope 数据层 — promoteScopeToUser", () => {
  it("project memory 提升到 user,删除原项目文件", async () => {
    await writeMemory(FIXED_CWD, { name: "promoteme", description: "d", type: "feedback", body: "B" });
    const ok = await promoteScopeToUser(FIXED_CWD, "promoteme");
    expect(ok).toBe(true);
    // user 有 + project 没了
    expect(existsSync(memoryFilePath(FIXED_CWD, "promoteme", "user"))).toBe(true);
    expect(existsSync(memoryFilePath(FIXED_CWD, "promoteme", "project"))).toBe(false);
    // 内容保持
    const promoted = await readMemory(FIXED_CWD, "promoteme", "user");
    expect(promoted.body).toBe("B");
    expect(promoted.frontmatter.source).toBe("promote-scope");
  });

  it("已经在 user scope → false(noop)", async () => {
    await writeMemory(FIXED_CWD, { name: "u-already", description: "u", type: "user", body: "b", scope: "user" });
    const ok = await promoteScopeToUser(FIXED_CWD, "u-already");
    expect(ok).toBe(false);
  });

  it("两 scope 都已存在 → 抛错(避免覆盖)", async () => {
    await writeMemory(FIXED_CWD, { name: "conflict", description: "p", type: "user", body: "p" });
    await writeMemory(FIXED_CWD, { name: "conflict", description: "u", type: "user", body: "u", scope: "user" });
    await expect(promoteScopeToUser(FIXED_CWD, "conflict")).rejects.toThrow(/already exists in user scope/);
  });

  it("name 不存在 → 抛错", async () => {
    await expect(promoteScopeToUser(FIXED_CWD, "nope")).rejects.toThrow(/does not exist/);
  });
});

describe("scope 数据层 — deleteMemory + setMemoryTrust 自动定位", () => {
  it("deleteMemory 自动定位 scope", async () => {
    await writeMemory(FIXED_CWD, { name: "dm", description: "d", type: "user", body: "b", scope: "user" });
    const removed = await deleteMemory(FIXED_CWD, "dm");
    expect(removed).toBe("user");
    expect(existsSync(memoryFilePath(FIXED_CWD, "dm", "user"))).toBe(false);
  });

  it("setMemoryTrust 自动定位 scope(project 优先)", async () => {
    await writeMemory(FIXED_CWD, { name: "shared", description: "p", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "shared", description: "u", type: "user", body: "b", scope: "user" });
    await setMemoryTrust(FIXED_CWD, "shared", "verified");
    // 只 project 升 verified;user 不变
    const p = await readMemory(FIXED_CWD, "shared", "project");
    const u = await readMemory(FIXED_CWD, "shared", "user");
    expect(p.frontmatter.trust).toBe("verified");
    expect(u.frontmatter.trust).toBe("auto");
  });

  it("setMemoryTrust 显式 scope=user 时只升 user 层", async () => {
    await writeMemory(FIXED_CWD, { name: "shared", description: "p", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "shared", description: "u", type: "user", body: "b", scope: "user" });
    await setMemoryTrust(FIXED_CWD, "shared", "verified", "user-edit", "user");
    const p = await readMemory(FIXED_CWD, "shared", "project");
    const u = await readMemory(FIXED_CWD, "shared", "user");
    expect(p.frontmatter.trust).toBe("auto");
    expect(u.frontmatter.trust).toBe("verified");
  });
});

describe("scope 数据层 — MEMORY.md 索引", () => {
  it("两 scope 各自维护独立的 MEMORY.md", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "p1 desc", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "u1 desc", type: "user", body: "b", scope: "user" });
    // 项目层索引
    const projectIndex = await import("../src/loop/memory.js").then((m) => m.loadMemoryIndex(FIXED_CWD));
    // loadMemoryIndex 合并两层,所以 project + user 都在
    expect(projectIndex).toContain("# project memory");
    expect(projectIndex).toContain("# user (global) memory");
    expect(projectIndex).toContain("p1");
    expect(projectIndex).toContain("u1");
  });
});
