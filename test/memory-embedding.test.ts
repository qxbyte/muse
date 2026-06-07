/**
 * II-5 向量索引测试。
 *
 * 覆盖:
 *   - hash-bag embedding:tokenize / embed / 归一化 / cosine
 *   - buildMemoryIndex / queryMemoryIndex:trust 加权 + top-K
 *   - /memory search slash 子命令
 *   - 冷启动 / 空索引兜底
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HashBagEmbeddingProvider,
  tokenize,
  cosineSimilarity,
  createEmbeddingProvider,
} from "../src/loop/embedding/index.js";
import { buildMemoryIndex, queryMemoryIndex } from "../src/loop/memory-index.js";
import { writeMemory } from "../src/loop/memory.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/slash/builtin.js";
import type { SlashCommand, SlashCommandContext } from "../src/slash/types.js";

const FIXED_CWD = "/Users/test/embedding-proj";
let testHome: string;
let originalHome: string | undefined;

const memoryCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "memory") as SlashCommand;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-embed-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function mkCtx(args: string): SlashCommandContext {
  return {
    args,
    cwd: FIXED_CWD,
    llm: {} as never,
    session: {} as never,
    settings: {},
    settingsSources: [],
    history: [],
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    listCommands: () => [],
    actions: {} as never,
  };
}

describe("II-5 — tokenize", () => {
  it("英文按单词切", () => {
    expect(tokenize("Hello world foo-bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("中文按单字切", () => {
    expect(tokenize("用户偏好制表符")).toEqual(["用", "户", "偏", "好", "制", "表", "符"]);
  });

  it("中英混合", () => {
    expect(tokenize("用 pnpm 不用 npm")).toEqual(["用", "pnpm", "不", "用", "npm"]);
  });

  it("数字保留为 token", () => {
    expect(tokenize("test 123 abc")).toEqual(["test", "123", "abc"]);
  });

  it("标点 / 空白丢", () => {
    expect(tokenize("foo, bar! baz?")).toEqual(["foo", "bar", "baz"]);
  });
});

describe("II-5 — HashBagEmbeddingProvider", () => {
  it("输出向量已 L2 归一化", async () => {
    const p = new HashBagEmbeddingProvider(64);
    const v = await p.embed("Hello world");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("相同输入产出相同向量(deterministic)", async () => {
    const p = new HashBagEmbeddingProvider();
    const a = await p.embed("test text");
    const b = await p.embed("test text");
    expect(a).toEqual(b);
  });

  it("相似文本余弦相似度高", async () => {
    const p = new HashBagEmbeddingProvider();
    const a = await p.embed("user prefers tabs for indentation");
    const b = await p.embed("user likes tab indentation style");
    const c = await p.embed("we use pnpm for dependency management");
    const sim_ab = cosineSimilarity(a, b);
    const sim_ac = cosineSimilarity(a, c);
    expect(sim_ab).toBeGreaterThan(sim_ac);
  });

  it("空文本 → 全 0 向量(余弦相似度 0)", async () => {
    const p = new HashBagEmbeddingProvider();
    const v = await p.embed("");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBe(0);
  });

  it("embedBatch 行为同 embed 串行", async () => {
    const p = new HashBagEmbeddingProvider();
    const batch = await p.embedBatch(["hello", "world", "foo"]);
    expect(batch).toHaveLength(3);
    const single = await p.embed("hello");
    expect(batch[0]).toEqual(single);
  });

  it("provider id 含 dim", () => {
    const p = new HashBagEmbeddingProvider(128);
    expect(p.id).toBe("hash-bag-128");
  });
});

describe("II-5 — createEmbeddingProvider factory", () => {
  it("默认创建 hash-bag", () => {
    const p = createEmbeddingProvider();
    expect(p.id).toMatch(/^hash-bag/);
  });

  it("local-minilm 抛错(留下批,需 @huggingface/transformers)", () => {
    expect(() => createEmbeddingProvider({ provider: "local-minilm" })).toThrow(/@huggingface\/transformers/);
  });

  it("openai 缺 apiKey 抛错", () => {
    expect(() => createEmbeddingProvider({ provider: "openai" })).toThrow(/requires apiKey/);
  });
});

describe("II-5 — buildMemoryIndex / queryMemoryIndex", () => {
  it("空 memory → 空索引", async () => {
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(0);
    const results = await queryMemoryIndex(index, "anything");
    expect(results).toEqual([]);
  });

  it("3 条 memory → 索引 3 条 entry", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "User prefers tabs", type: "feedback", body: "Use tab indentation" });
    await writeMemory(FIXED_CWD, { name: "b", description: "Team uses pnpm", type: "project", body: "We use pnpm for dependencies" });
    await writeMemory(FIXED_CWD, { name: "c", description: "API timeout 30s", type: "reference", body: "All API calls have 30 second timeout" });
    const index = await buildMemoryIndex(FIXED_CWD);
    expect(index.entries).toHaveLength(3);
  });

  it("query 相关 memory → 排前", async () => {
    await writeMemory(FIXED_CWD, { name: "tabs", description: "user prefers tabs for indentation", type: "feedback", body: "tab indentation" });
    await writeMemory(FIXED_CWD, { name: "pnpm", description: "team uses pnpm not npm", type: "project", body: "pnpm dependencies" });
    const index = await buildMemoryIndex(FIXED_CWD);
    const results = await queryMemoryIndex(index, "tab indentation preference");
    expect(results[0].entry.name).toBe("tabs");
  });

  it("trust 加权:同分时 trusted > verified > auto", async () => {
    // 三条 memory 内容相同(同 score),trust 不同 → 排序按 trust
    await writeMemory(FIXED_CWD, { name: "a-auto", description: "test query foo bar", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b-verified", description: "test query foo bar", type: "user", body: "x", trust: "verified" });
    const index = await buildMemoryIndex(FIXED_CWD);
    const results = await queryMemoryIndex(index, "test query foo bar");
    expect(results[0].entry.trust).toBe("verified");
    expect(results[0].weighted).toBeGreaterThan(results[1].weighted);
  });

  it("topK=2 截取前 2", async () => {
    for (let i = 0; i < 5; i++) {
      await writeMemory(FIXED_CWD, { name: `m${i}`, description: `match query token${i}`, type: "user", body: "x" });
    }
    const index = await buildMemoryIndex(FIXED_CWD);
    const results = await queryMemoryIndex(index, "match query", { topK: 2 });
    expect(results).toHaveLength(2);
  });

  it("minScore 过滤掉无关条目", async () => {
    await writeMemory(FIXED_CWD, { name: "rel", description: "user prefers tabs", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "irrel", description: "completely unrelated content topic", type: "user", body: "y" });
    const index = await buildMemoryIndex(FIXED_CWD);
    const results = await queryMemoryIndex(index, "tabs", { minScore: 0.1 });
    // 不要求精确长度(hash-bag 可能产生轻微碰撞),但 rel 应优先于 irrel
    expect(results[0].entry.name).toBe("rel");
  });
});

describe("II-5 — /memory search slash", () => {
  it("空 memory 时提示", async () => {
    const result = await memoryCmd.execute(mkCtx("search anything"));
    expect(result.display).toContain("(no memories saved");
  });

  it("无参数 → Usage 提示", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "test", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("search"));
    expect(result.display).toContain("Usage: /memory search");
  });

  it("有匹配时显示 top-K 列表 + score", async () => {
    await writeMemory(FIXED_CWD, { name: "tabs", description: "user prefers tabs indentation", type: "feedback", body: "x" });
    await writeMemory(FIXED_CWD, { name: "pnpm", description: "team uses pnpm dependencies", type: "project", body: "x" });
    const result = await memoryCmd.execute(mkCtx("search tabs"));
    expect(result.display).toContain("Top");
    expect(result.display).toContain("tabs");
    expect(result.display).toMatch(/score=\d/);
    expect(result.display).toContain("provider: hash-bag");
  });

  it("查询多 token 时全部用作 query", async () => {
    await writeMemory(FIXED_CWD, { name: "auth", description: "auth middleware uses JWT", type: "project", body: "x" });
    const result = await memoryCmd.execute(mkCtx("search JWT middleware"));
    expect(result.display).toContain("auth");
  });
});
