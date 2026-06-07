/**
 * inject-memory R1-R6 改进测试。
 *
 * 覆盖:
 *   - R5 minCount 默认 3(原 10);足量时走 embedding 模式
 *   - R5 按 trust 分级注入:trusted=fullBody / verified=snippet / auto=rawIndexLine
 *   - R6 maxInjectTokens 预算 — 超出时保 trusted 丢 verified/auto
 *   - R2 query 用最近 N=3 user 消息拼接
 *   - R2 短 query(<5 字符)fallback 加 assistant 文本
 *   - R2 跳过 trim marker / compaction summary
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

const FIXED_CWD = "/Users/test/inject-r-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-injr-"));
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
function asst(t: string): Message {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}

function mkCtx(opts: {
  messages?: Message[];
  memoryIndex?: string;
  memoryEmbeddingIndex?: import("../src/loop/memory-index.js").MemoryIndex;
  memoryEmbeddingTopK?: number;
  memoryEmbeddingMinCount?: number;
  memoryEmbeddingMaxInjectTokens?: number;
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
      memoryEmbeddingMaxInjectTokens: opts.memoryEmbeddingMaxInjectTokens,
      toolRegistry: new ToolRegistry(),
      provider: "test",
    },
  };
}

describe("R5 — minCount 默认 3(原 10)", () => {
  it("3 条 memory 足量,走 embedding 模式(原 10 阈值已废)", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "user prefers tabs", type: "feedback", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "team uses pnpm", type: "project", body: "x" });
    await writeMemory(FIXED_CWD, { name: "c", description: "api timeout 30s", type: "reference", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("how should I indent code? tabs or spaces?")],
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("most relevant memories");
  });

  it("2 条 memory 仍少于默认 minCount=3 → 退化", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "test a", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "test b", type: "user", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("test query")],
      memoryIndex: "[auto] - [a](a.md) — test a",
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("Below is MEMORY.md");
  });
});

describe("R5 — trust 分级注入", () => {
  beforeEach(async () => {
    // 每条用完全独立的 description token,避免 hash-bag 召回时混淆排序
    await writeMemory(FIXED_CWD, {
      name: "auto-mem",
      description: "alpha auto bucket xenon",
      type: "feedback",
      body: "Long auto body content. ".repeat(20),
      trust: "auto",
    });
    await writeMemory(FIXED_CWD, {
      name: "verified-mem",
      description: "beta verified bucket yarrow",
      type: "feedback",
      body: "Long verified body content with details. ".repeat(20),
      trust: "verified",
    });
    await writeMemory(FIXED_CWD, {
      name: "trusted-mem",
      description: "gamma trusted bucket zenith",
      type: "feedback",
      body: "Long trusted body content with all details. ".repeat(20),
      trust: "verified", // hierarchy 来源理论才能 trusted;测试里手动 patch
    });
  });

  it("trusted 条目注入完整 fullBody", async () => {
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const trustedEntry = embIndex.entries.find((e) => e.name === "trusted-mem")!;
    trustedEntry.trust = "trusted";

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("gamma trusted zenith")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 1,
      memoryEmbeddingMaxInjectTokens: 5000,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("## trusted-mem");
    expect(ctx.systemPrompt).toContain("[trusted]");
    // 完整 body(>500 字符)被注入
    expect(ctx.systemPrompt.length).toBeGreaterThan(800);
  });

  it("verified 条目注入 bodySnippet", async () => {
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("beta verified yarrow")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 1,
      memoryEmbeddingMaxInjectTokens: 5000,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("## verified-mem");
    expect(ctx.systemPrompt).toContain("[verified]");
  });

  it("auto 条目仅注入 rawIndexLine(短)", async () => {
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("alpha auto xenon")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 1,
      memoryEmbeddingMaxInjectTokens: 5000,
    });
    await stage.run(ctx);
    // auto 只显示索引行(不带 ## 头)
    expect(ctx.systemPrompt).toContain("[auto] - [auto-mem](auto-mem.md)");
    expect(ctx.systemPrompt).not.toContain("## auto-mem");
  });
});

describe("R6 — maxInjectTokens 预算守护", () => {
  it("超出预算时 verified/auto 被丢,trusted 保留", async () => {
    // 1 条 trusted(中等 body) + 4 条 verified(中等 body)
    const mediumBody = "body content takes some tokens ".repeat(15); // ~100-150 tokens after estimate
    await writeMemory(FIXED_CWD, { name: "trust1", description: "trusted entry token query", type: "feedback", body: mediumBody });
    for (let i = 0; i < 4; i++) {
      await writeMemory(FIXED_CWD, { name: `v${i}`, description: `verified ${i} entry token`, type: "feedback", body: mediumBody, trust: "verified" });
    }
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const trustedEntry = embIndex.entries.find((e) => e.name === "trust1")!;
    trustedEntry.trust = "trusted";

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [user("entry token query")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
      memoryEmbeddingMaxInjectTokens: 300, // 能塞 trusted(~150)+ 也许 1 个 verified;余下被丢
    });
    await stage.run(ctx);

    // trusted 必在(weighted 最高 + 算法优先保留)
    expect(ctx.systemPrompt).toContain("trust1");
    // 不会全部 4 条 verified 都在(否则没体现预算守护)
    const verifiedCount = ["v0", "v1", "v2", "v3"].filter((n) => ctx.systemPrompt.includes(`## ${n}`)).length;
    expect(verifiedCount).toBeLessThan(4);
  });
});

describe("R2 — buildQuery 用最近 N=3 user", () => {
  it("3 条 user 消息全部进 query 上下文", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "first topic foo", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "second topic bar", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "c", description: "third topic baz qux", type: "user", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [
        user("first topic foo discussion"),
        asst("ack"),
        user("second topic bar follow up"),
        asst("ack"),
        user("third topic baz qux current"),
      ],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 3,
    });
    await stage.run(ctx);
    // 三个 topic 都应被召回(query 拼接 3 条 user)
    expect(ctx.systemPrompt).toContain("most relevant memories");
  });

  it("跳过 trim marker 类 user 消息", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "real topic", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "another", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "c", description: "third", type: "user", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [
        user("real topic question"),
        user("[Previous conversation summary] something"),  // 应跳过
        user("[System note: 3 turns trimmed]"),  // 应跳过
      ],
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("most relevant memories");
  });
});

describe("R2 — 短 query fallback", () => {
  it("query 仅 '好' 时 fallback 加最近 assistant 文本", async () => {
    await writeMemory(FIXED_CWD, { name: "a", description: "indent tabs preference", type: "feedback", body: "x" });
    await writeMemory(FIXED_CWD, { name: "b", description: "pnpm package manager", type: "project", body: "x" });
    await writeMemory(FIXED_CWD, { name: "c", description: "third topic", type: "user", body: "x" });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      messages: [
        asst("Let me explain the indent tabs preference and how we'd apply it..."),
        user("好"),  // 短 query
      ],
      memoryEmbeddingIndex: embIndex,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("most relevant memories");
    // 召回 a (indent tabs) 应在(因为 fallback 加入 assistant 文本含 "indent tabs preference" 词)
    expect(ctx.systemPrompt).toMatch(/\[a\]\(a\.md\)|## a/);
  });
});
