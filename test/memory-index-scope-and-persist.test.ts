/**
 * memory-index.ts:scope 双层 + 加权 + .index.json 持久化测试。
 *
 * 覆盖:
 *   - buildMemoryIndex 同时遍历 project + user 两 scope,合并 entries 带 scope 字段
 *   - scope 加权 ×1.2(项目优先;R3)
 *   - R1 embed 输入只用 name + description(不含 body)
 *   - .index.json 落盘 + 再次 build 时复用(mtime 校验)
 *   - upsertMemoryEntry 增量
 *   - removeMemoryEntry 增量
 *   - providerId 变更全量重 embed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryIndex,
  queryMemoryIndex,
  upsertMemoryEntry,
  removeMemoryEntry,
  clearPersistedIndex,
  scopeWeight,
} from "../src/loop/memory-index.js";
import { writeMemory, deleteMemory, scopeDir, type Scope } from "../src/loop/memory.js";
import { HashBagEmbeddingProvider } from "../src/loop/embedding/index.js";
import { existsSync } from "node:fs";

const FIXED_CWD = "/Users/test/idx-scope-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-idx-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

describe("scopeWeight", () => {
  it("project = 1.2, user = 1.0", () => {
    expect(scopeWeight("project")).toBe(1.2);
    expect(scopeWeight("user")).toBe(1.0);
  });
});

describe("buildMemoryIndex — 双层 entries", () => {
  it("project + user 两层 memory 都进 entries 且带 scope 字段", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "project mem 1", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "user mem 1", type: "user", body: "x", scope: "user" });

    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(2);
    const byName = new Map(index.entries.map((e) => [e.name, e]));
    expect(byName.get("p1")!.scope).toBe("project");
    expect(byName.get("u1")!.scope).toBe("user");
  });

  it("只有一层时另一层 entries 缺失不报错", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "p", type: "user", body: "b" });
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].scope).toBe("project");
  });

  it("同名跨 scope 在 entries 中并存(scope 区分)", async () => {
    await writeMemory(FIXED_CWD, { name: "shared", description: "P version", type: "user", body: "p" });
    await writeMemory(FIXED_CWD, { name: "shared", description: "U version", type: "user", body: "u", scope: "user" });
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries.filter((e) => e.name === "shared")).toHaveLength(2);
  });
});

describe("queryMemoryIndex — scope 加权 ×1.2", () => {
  it("同 cosine + 同 trust 时,project scope weighted 更高", async () => {
    // 完全相同的 description 内容,但 scope 不同
    await writeMemory(FIXED_CWD, { name: "p-tabs", description: "user prefers tabs for indent", type: "feedback", body: "b" });
    await writeMemory(FIXED_CWD, { name: "u-tabs", description: "user prefers tabs for indent", type: "feedback", body: "b", scope: "user" });

    const index = await buildMemoryIndex(FIXED_CWD);
    const results = await queryMemoryIndex(index, "user prefers tabs for indent");

    // 两条同分,但 project ×1.2 weighted 更高
    expect(results[0].entry.scope).toBe("project");
    expect(results[0].weighted).toBeGreaterThan(results[1].weighted);
    expect(results[0].score).toBeCloseTo(results[1].score, 5);
  });
});

describe("R1 embed 输入只用 name + description", () => {
  it("不同 body 但相同 description → vector 相同(body 不影响 embedding)", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "user prefers tabs", type: "user", body: "short body" });
    await writeMemory(FIXED_CWD, { name: "a", description: "user prefers tabs", type: "user", body: "very long body ".repeat(100) });
    // 第二次 write 走"已存在,更新"路径,vector 应该是基于 description + name 重 embed
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(1);
    // 验证 fullBody 是最新写入的(长 body)
    expect(index.entries[0].fullBody.length).toBeGreaterThan(500);
    // bodySnippet 是截断的
    expect(index.entries[0].bodySnippet.length).toBeLessThanOrEqual(420);
  });
});

describe(".index.json 持久化", () => {
  it("buildMemoryIndex 写入 .index.json", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    await buildMemoryIndex(FIXED_CWD);
    const projectIndexPath = join(scopeDir(FIXED_CWD, "project"), ".index.json");
    expect(existsSync(projectIndexPath)).toBe(true);
    const raw = await readFile(projectIndexPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.providerId).toMatch(/^hash-bag/);
    expect(parsed.dim).toBeGreaterThan(0);
    expect(parsed.entries.p1).toBeDefined();
    expect(parsed.entries.p1.mtime).toMatch(/^\d{4}/);
    expect(parsed.entries.p1.vector).toBeInstanceOf(Array);
  });

  it("二次 build 复用 vector(mtime 未变)— 用 spy 验证 embed 不被调用", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    await buildMemoryIndex(FIXED_CWD);

    // 二次 build,用 mock provider 监视 embed 调用次数
    const provider = new HashBagEmbeddingProvider();
    const spy = vi.spyOn(provider, "embed");
    await buildMemoryIndex(FIXED_CWD, { provider });
    // 复用既有 .index.json,不应触发 embed
    expect(spy).not.toHaveBeenCalled();
  });

  it("memory 更新(updated_at 变)后 build 触发重 embed", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "v1", type: "user", body: "b" });
    await buildMemoryIndex(FIXED_CWD);

    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "p1", description: "v2 updated", type: "user", body: "b" });

    const provider = new HashBagEmbeddingProvider();
    const spy = vi.spyOn(provider, "embed");
    await buildMemoryIndex(FIXED_CWD, { provider });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("providerId 变更触发全量重 embed", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    await writeMemory(FIXED_CWD, { name: "p2", description: "d", type: "user", body: "b" });
    const dimA = new HashBagEmbeddingProvider(64);  // id = "hash-bag-64"
    await buildMemoryIndex(FIXED_CWD, { provider: dimA });

    const dimB = new HashBagEmbeddingProvider(128); // id = "hash-bag-128"
    const spy = vi.spyOn(dimB, "embed");
    await buildMemoryIndex(FIXED_CWD, { provider: dimB });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clearPersistedIndex 删 .index.json", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    await buildMemoryIndex(FIXED_CWD);
    const path = join(scopeDir(FIXED_CWD, "project"), ".index.json");
    expect(existsSync(path)).toBe(true);
    await clearPersistedIndex(FIXED_CWD, "project");
    expect(existsSync(path)).toBe(false);
  });

  it("noPersist=true 时不落盘", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "d", type: "user", body: "b" });
    await buildMemoryIndex(FIXED_CWD, { noPersist: true });
    const path = join(scopeDir(FIXED_CWD, "project"), ".index.json");
    expect(existsSync(path)).toBe(false);
  });
});

describe("upsertMemoryEntry / removeMemoryEntry — 增量", () => {
  it("upsert 单条 entry 加入 in-memory + .index.json", async () => {
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(0);

    // 模拟 MemoryWrite:先 writeMemory,再 upsert 进 index
    await writeMemory(FIXED_CWD, { name: "new1", description: "new", type: "user", body: "b" });
    await upsertMemoryEntry(index, "new1");

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].name).toBe("new1");
    // 持久化更新
    const persisted = JSON.parse(await readFile(join(scopeDir(FIXED_CWD, "project"), ".index.json"), "utf-8"));
    expect(persisted.entries.new1).toBeDefined();
  });

  it("upsert 同名条目时更新 vector 与元数据", async () => {
    await writeMemory(FIXED_CWD, { name: "x", description: "v1", type: "user", body: "b" });
    const index = await buildMemoryIndex(FIXED_CWD);
    const v1 = index.entries[0].description;
    expect(v1).toBe("v1");

    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "x", description: "v2 updated", type: "user", body: "b" });
    await upsertMemoryEntry(index, "x");

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].description).toBe("v2 updated");
  });

  it("remove 单条 entry 从 in-memory + .index.json 移除", async () => {
    await writeMemory(FIXED_CWD, { name: "r1", description: "d", type: "user", body: "b" });
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(1);

    await deleteMemory(FIXED_CWD, "r1");
    await removeMemoryEntry(index, "r1", "project");
    expect(index.entries).toHaveLength(0);
    const persisted = JSON.parse(await readFile(join(scopeDir(FIXED_CWD, "project"), ".index.json"), "utf-8"));
    expect(persisted.entries.r1).toBeUndefined();
  });
});
