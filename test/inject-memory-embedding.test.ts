/**
 * inject-memory stage embedding mode 接入测试。
 *
 * 设计:Agent 记忆系统/设计.md §4.5;消息预处理工程/设计.md §4.2.2。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InjectMemoryStage } from "../src/preprocess/request/inject-memory.js";
import type { RequestCtx } from "../src/preprocess/request/index.js";
import { TodoStore } from "../src/loop/todos.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { writeMemory } from "../src/loop/memory.js";
import { buildMemoryIndex } from "../src/loop/memory-index.js";
import type { Message } from "../src/types/index.js";

const FIXED_CWD = "/Users/test/inject-mem-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-injmem-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function user(t: string): Message {
  return { role: "user", content: t };
}

function mkCtx(opts: {
  messages?: Message[];
  memoryIndex?: string;
  memoryEmbeddingIndex?: import("../src/loop/memory-index.js").MemoryIndex;
  memoryEmbeddingTopK?: number;
  memoryEmbeddingMinCount?: number;
} = {}): RequestCtx {
  return {
    messages: opts.messages ?? [],
    systemPrompt: "BASE",
    tools: [],
    modelId: "test",
    mode: "default",
    cwd: FIXED_CWD,
    settings: {},
    services: {
      todos: new TodoStore(),
      memoryIndex: opts.memoryIndex ?? "",
      memoryEmbeddingIndex: opts.memoryEmbeddingIndex,
      memoryEmbeddingTopK: opts.memoryEmbeddingTopK,
      memoryEmbeddingMinCount: opts.memoryEmbeddingMinCount,
      toolRegistry: new ToolRegistry(),
      provider: "test",
    },
  };
}

describe("inject-memory — 全文模式(基线)", () => {
  it("有 memoryIndex 字符串时注入到 systemPrompt 末尾", async () => {
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({ memoryIndex: "[auto] - [foo](foo.md) — foo description" });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("BASE");
    expect(ctx.systemPrompt).toContain("# Memory (long-term)");
    expect(ctx.systemPrompt).toContain("[auto] - [foo](foo.md)");
    expect(ctx.systemPrompt).toContain("[trusted]");
    expect(ctx.systemPrompt).toContain("MemoryWrite");
  });

  it("空 memoryIndex + 无 embedding → 不注入", async () => {
    const stage = new InjectMemoryStage();
    const ctx = mkCtx();
    await stage.run(ctx);
    expect(ctx.systemPrompt).toBe("BASE");
  });
});

describe("inject-memory — embedding 模式", () => {
  it("有 embedding index + memory >= minCount + 有 user query + 召回命中 → 注入精简索引", async () => {
    // 构造 12 条 memory(超过默认 minCount=10),其中含与 query 相关的条目
    for (let i = 0; i < 10; i++) {
      await writeMemory(FIXED_CWD, {
        name: `noise-${i}`,
        description: `unrelated noise topic number ${i}`,
        type: "user",
        body: "unrelated body",
      });
    }
    await writeMemory(FIXED_CWD, {
      name: "tabs-pref",
      description: "user prefers tabs for indentation",
      type: "feedback",
      body: "tabs not spaces",
    });
    await writeMemory(FIXED_CWD, {
      name: "pnpm-team",
      description: "team uses pnpm not npm",
      type: "project",
      body: "pnpm dependencies",
    });

    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("How should I indent code? Use tabs or spaces?")],
      memoryIndex: "[auto] - [noise-0](noise-0.md) — old full index",
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 3,
    });
    await stage.run(ctx);
    // 应注入精简(top-3)索引,不是全文索引
    expect(ctx.systemPrompt).toContain("tabs-pref"); // 相关条目应被召回
    expect(ctx.systemPrompt).toContain("most relevant memories"); // embedding 模式 notice
    // 全文索引那条 noise-0 — 也可能在 top-3 里(hash-bag 容易碰撞),但 mode 提示一定是 embedding
  });

  it("有 embedding index 但 memory < minCount → 退化到全文模式", async () => {
    // 只 2 条 memory,< minCount=10
    await writeMemory(FIXED_CWD, { name: "a", description: "test a", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "test b", type: "user", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("what is the test?")],
      memoryIndex: "[auto] - [a](a.md) — test a\n[auto] - [b](b.md) — test b",
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    // 全文模式 notice
    expect(ctx.systemPrompt).toContain("Below is MEMORY.md");
    expect(ctx.systemPrompt).not.toContain("most relevant memories");
    expect(ctx.systemPrompt).toContain("[a](a.md)");
  });

  it("有 embedding index 但无 user query → 退化到全文", async () => {
    for (let i = 0; i < 12; i++) {
      await writeMemory(FIXED_CWD, { name: `m${i}`, description: `desc ${i}`, type: "user", body: "x" });
    }
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [], // 无 user
      memoryIndex: "[auto] - [m0](m0.md) — desc 0",
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("Below is MEMORY.md");
    expect(ctx.systemPrompt).not.toContain("most relevant memories");
  });

  it("system note 类 user message 被跳过(从 trim marker 提取 query 不合理)", async () => {
    // 含一条 token 重合的 memory + 11 条 noise(超 minCount=10)
    await writeMemory(FIXED_CWD, { name: "tabs", description: "user tabs preference for indentation", type: "feedback", body: "x" });
    for (let i = 0; i < 11; i++) {
      await writeMemory(FIXED_CWD, { name: `m${i}`, description: `unrelated noise filler ${i}`, type: "user", body: "x" });
    }
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [
        user("tabs indentation preference question"),
        user("[Previous conversation summary] something"), // trim marker — 应跳过
      ],
      memoryIndex: "[auto] - [m0](m0.md) — fallback",
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    // 走 embedding 模式(因为跳过 trim marker → 找到真 user query → 召回命中)
    expect(ctx.systemPrompt).toContain("most relevant memories");
    expect(ctx.systemPrompt).toContain("tabs");
  });

  it("最低 minMemoryCount 配置生效", async () => {
    // 3 条 memory,设 minMemoryCount=2 → 走 embedding 模式
    await writeMemory(FIXED_CWD, { name: "a", description: "user tabs preference", type: "feedback", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "team pnpm dependencies", type: "project", body: "x" });
    await writeMemory(FIXED_CWD, { name: "c", description: "API timeout 30 seconds", type: "reference", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("how about tabs vs spaces?")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingMinCount: 2, // 显式降低阈值
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("most relevant memories");
  });
});

describe("inject-memory — embedding 模式退化场景", () => {
  it("embedding index entries 为空时退化", async () => {
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("anything")],
      memoryIndex: "[auto] - [foo](foo.md) — foo",
      memoryEmbeddingIndex: {
        provider: { id: "stub", dim: 1, embed: async () => [0], embedBatch: async () => [[0]] },
        entries: [],
        builtAt: new Date().toISOString(),
      },
      memoryEmbeddingMinCount: 0,
    });
    await stage.run(ctx);
    // 不会注入 embedding 段(因为退化条件: entries < minCount;这里 0 == 0 走 embedding,
    // 但 entries 为空召回 0 → 再退化到全文)
    expect(ctx.systemPrompt).toContain("Below is MEMORY.md");
    expect(ctx.systemPrompt).toContain("[foo](foo.md)");
  });
});
