/**
 * II-4 trust 字段测试。
 *
 * 隔离策略:每个 test 用 mkdtemp 临时 HOME,避免污染真实 ~/.muse/。
 * memory.ts 里 memoryDir 走 `homedir() + .muse/projects/<hash>/memory/`,
 * POSIX 下 homedir() 优先读 $HOME,改环境变量立即生效。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMemory,
  readMemory,
  readMemoryFile,
  setMemoryTrust,
  deleteMemory,
  listMemories,
  loadMemoryIndex,
  memoryDir,
  memoryFilePath,
  memoryIndexPath,
  trustRank,
} from "../src/loop/memory.js";

const FIXED_CWD = "/Users/test/some-project";  // 任意虚构 cwd;hash 决定 memoryDir
let originalHome: string | undefined;
let testHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-test-"));
  process.env.HOME = testHome;
});

afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

describe("II-4 trust 字段 — writeMemory", () => {
  it("新建时默认 trust=auto, source=manual-write, timestamps 写入", async () => {
    await writeMemory(FIXED_CWD, {
      name: "test-1",
      description: "user prefers tabs",
      type: "user",
      body: "User likes tab indentation.",
    });
    const file = await readMemory(FIXED_CWD, "test-1");
    expect(file.frontmatter.trust).toBe("auto");
    expect(file.frontmatter.source).toBe("manual-write");
    expect(file.frontmatter.type).toBe("user");
    expect(file.frontmatter.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(file.frontmatter.updated_at).toBe(file.frontmatter.created_at);
    expect(file.body).toBe("User likes tab indentation.");
  });

  it("显式传 trust=verified 时生效", async () => {
    await writeMemory(FIXED_CWD, {
      name: "test-2",
      description: "verified fact",
      type: "feedback",
      body: "Some body.",
      trust: "verified",
      source: "user-remember",
    });
    const file = await readMemory(FIXED_CWD, "test-2");
    expect(file.frontmatter.trust).toBe("verified");
    expect(file.frontmatter.source).toBe("user-remember");
  });

  it("更新已存在时保留 created_at,刷新 updated_at", async () => {
    await writeMemory(FIXED_CWD, {
      name: "test-3",
      description: "v1",
      type: "user",
      body: "v1 body",
    });
    const first = await readMemory(FIXED_CWD, "test-3");
    const firstCreated = first.frontmatter.created_at;
    // 等 5ms 让 ISO 时间戳能区别
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, {
      name: "test-3",
      description: "v2",
      type: "user",
      body: "v2 body",
    });
    const second = await readMemory(FIXED_CWD, "test-3");
    expect(second.frontmatter.created_at).toBe(firstCreated);
    expect(second.frontmatter.updated_at).not.toBe(firstCreated);
    expect(second.frontmatter.description).toBe("v2");
    expect(second.body).toBe("v2 body");
  });

  it("升级语义:已有 verified 时,新 write 用 auto 不会降级", async () => {
    await writeMemory(FIXED_CWD, {
      name: "test-4",
      description: "verified",
      type: "feedback",
      body: "body",
      trust: "verified",
    });
    await writeMemory(FIXED_CWD, {
      name: "test-4",
      description: "auto override attempt",
      type: "feedback",
      body: "body2",
      trust: "auto",
    });
    const file = await readMemory(FIXED_CWD, "test-4");
    expect(file.frontmatter.trust).toBe("verified");
  });
});

describe("II-4 trust 字段 — readMemory 懒填", () => {
  it("旧文件无 trust 字段时懒填 trust=auto + mtime", async () => {
    // 手工写一份"旧版本" memory(无 trust/source/timestamps)
    const dir = memoryDir(FIXED_CWD);
    await mkdir(dir, { recursive: true });
    const oldContent = `---
name: legacy
description: 旧版无 trust
metadata:
  type: project
---

legacy body
`;
    await writeFile(memoryFilePath(FIXED_CWD, "legacy"), oldContent, "utf-8");
    const file = await readMemory(FIXED_CWD, "legacy");
    expect(file.frontmatter.trust).toBe("auto");
    expect(file.frontmatter.source).toBe("manual-write");
    expect(file.frontmatter.type).toBe("project");
    expect(file.frontmatter.created_at).toMatch(/^\d{4}/);
    expect(file.body).toBe("legacy body");
  });

  it("readMemoryFile 返回完整文件原文(含 frontmatter)", async () => {
    await writeMemory(FIXED_CWD, {
      name: "raw-test",
      description: "raw",
      type: "user",
      body: "raw body",
    });
    const raw = await readMemoryFile(FIXED_CWD, "raw-test");
    expect(raw).toContain("---");
    expect(raw).toContain("trust: auto");
    expect(raw).toContain("raw body");
  });
});

describe("II-4 trust 字段 — setMemoryTrust", () => {
  it("升级 auto → verified 成功", async () => {
    await writeMemory(FIXED_CWD, {
      name: "promote-1",
      description: "p",
      type: "user",
      body: "b",
    });
    await setMemoryTrust(FIXED_CWD, "promote-1", "verified");
    const file = await readMemory(FIXED_CWD, "promote-1");
    expect(file.frontmatter.trust).toBe("verified");
    expect(file.frontmatter.source).toBe("user-edit");
  });

  it("降级 verified → auto 抛错", async () => {
    await writeMemory(FIXED_CWD, {
      name: "promote-2",
      description: "p",
      type: "user",
      body: "b",
      trust: "verified",
    });
    await expect(setMemoryTrust(FIXED_CWD, "promote-2", "auto")).rejects.toThrow(
      /Cannot lower trust/,
    );
  });

  it("相同 trust + source 时 no-op(不刷 updated_at)", async () => {
    await writeMemory(FIXED_CWD, {
      name: "noop",
      description: "n",
      type: "user",
      body: "b",
      trust: "verified",
      source: "user-edit",
    });
    const before = await readMemory(FIXED_CWD, "noop");
    await new Promise((r) => setTimeout(r, 10));
    await setMemoryTrust(FIXED_CWD, "noop", "verified", "user-edit");
    const after = await readMemory(FIXED_CWD, "noop");
    expect(after.frontmatter.updated_at).toBe(before.frontmatter.updated_at);
  });
});

describe("II-4 trust 字段 — listMemories 排序", () => {
  it("按 trust 降序 → updated_at 降序", async () => {
    // 加 sleep 让 ISO 时间戳 ms 级有区分
    await writeMemory(FIXED_CWD, { name: "a-auto", description: "a", type: "user", body: "b" });
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "b-verified", description: "b", type: "user", body: "b", trust: "verified" });
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "c-auto", description: "c", type: "user", body: "b" });
    const list = await listMemories(FIXED_CWD);
    expect(list.map((f) => f.frontmatter.name)).toEqual(["b-verified", "c-auto", "a-auto"]);
    // c-auto 排在 a-auto 之前(同 trust 时按 updated_at 降序)
  });
});

describe("II-4 trust 字段 — deleteMemory", () => {
  it("删文件 + 移除索引行", async () => {
    await writeMemory(FIXED_CWD, { name: "del", description: "d", type: "user", body: "b" });
    const idxBefore = await readFile(memoryIndexPath(FIXED_CWD), "utf-8");
    expect(idxBefore).toContain("del");
    await deleteMemory(FIXED_CWD, "del");
    const idxAfter = await readFile(memoryIndexPath(FIXED_CWD), "utf-8");
    expect(idxAfter).not.toContain("del");
  });
});

describe("II-4 trust 字段 — MEMORY.md 索引格式", () => {
  it("行格式 `[trust] - [name](name.md) — description`", async () => {
    await writeMemory(FIXED_CWD, {
      name: "fmt-test",
      description: "用户偏好制表符",
      type: "feedback",
      body: "...",
      trust: "verified",
    });
    const idx = await loadMemoryIndex(FIXED_CWD);
    expect(idx).toContain("[verified] - [fmt-test](fmt-test.md) — 用户偏好制表符");
  });

  it("trustRank: trusted=2, verified=1, auto=0", () => {
    expect(trustRank("trusted")).toBe(2);
    expect(trustRank("verified")).toBe(1);
    expect(trustRank("auto")).toBe(0);
  });
});
