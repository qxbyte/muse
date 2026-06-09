/**
 * O1 + O5 inject-memory 改动测试。
 *
 * O1 — budget 紧张时动态降量(向量模式 maxTokens × scale;全文模式按行裁)。
 * O5 — 召回输出按 name 字典序,保证同一 query 下字节级稳定(prompt cache 友好)。
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

const FIXED_CWD = "/Users/test/inj-budget-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-injmem-bud-"));
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
  systemPrompt?: string;
  memoryIndex?: string;
  memoryEmbeddingIndex?: import("../src/loop/memory-index.js").MemoryIndex;
  memoryEmbeddingTopK?: number;
  memoryEmbeddingMinCount?: number;
  contextWindow?: number;
} = {}): RequestCtx {
  return {
    messages: opts.messages ?? [],
    systemPrompt: opts.systemPrompt ?? "BASE",
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
      contextWindow: opts.contextWindow,
    },
  };
}

describe("O1 — inject-memory 动态降量(全文模式)", () => {
  // 用 220 行(>200 默认上限)的索引文本
  const bigIndex = Array.from({ length: 220 }, (_, i) => `[auto] - [m${i}](m${i}.md) — entry ${i}`).join("\n");

  it("无 contextWindow → scale 1.0,完整注入(loadMemoryIndex 在 caller 已截 200 行级别 — 此处直传 bigIndex)", async () => {
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({ memoryIndex: bigIndex }); // 无 contextWindow
    await stage.run(ctx);
    // 全行都在(220 行,小于 truncateIndexByLines(200)— 220 > 200,实际会被截)
    // scale=1.0 ⇒ maxLines=200(DEFAULT_FULL_INDEX_MAX_LINES * 1.0)
    expect(ctx.systemPrompt).toContain("m0](m0.md)");
    // 第 200 行后会被截
    expect(ctx.systemPrompt).toContain("20 more lines truncated for budget");
  });

  it("budget 占用 <60% → scale=1.0(完整注入,只走默认 200 行截断)", async () => {
    const stage = new InjectMemoryStage();
    const ctx = mkCtx({
      memoryIndex: bigIndex,
      messages: [user("hi")],
      contextWindow: 200_000,
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("m0](m0.md)");
  });

  it("budget 占用 60-80% → scale=0.5(maxLines=100)", async () => {
    const stage = new InjectMemoryStage();
    // 构造一个让 systemPrompt + messages 占 ~65% 的场景
    // contextWindow=1000 → 必须有 ~650 token 占用 → systemPrompt 拉长
    const heavyPrompt = "x ".repeat(1500); // ~1500 token
    const ctx = mkCtx({
      memoryIndex: bigIndex,
      systemPrompt: heavyPrompt,
      contextWindow: 2300, // ~65% used
    });
    await stage.run(ctx);
    // 注入文本应只到 ~100 行
    expect(ctx.systemPrompt).toContain("m0](m0.md)");
    expect(ctx.systemPrompt).toContain("more lines truncated for budget");
    expect(ctx.systemPrompt).not.toContain("m150](m150.md)"); // scale=0.5 → 截到 100 行
  });

  it("budget 占用 >80% → scale=0.25(maxLines=50)", async () => {
    const stage = new InjectMemoryStage();
    const heavyPrompt = "x ".repeat(1500);
    const ctx = mkCtx({
      memoryIndex: bigIndex,
      systemPrompt: heavyPrompt,
      contextWindow: 1700, // ~88% used
    });
    await stage.run(ctx);
    expect(ctx.systemPrompt).toContain("m0](m0.md)");
    expect(ctx.systemPrompt).not.toContain("m100](m100.md)");
    expect(ctx.systemPrompt).not.toContain("m60](m60.md)");
  });
});

describe("O1 — inject-memory 动态降量(向量模式 maxTokens)", () => {
  it("budget 紧张时 maxInjectTokens 按 scale 缩放", async () => {
    // 构造 5 条 memory,body 较长 → 满量注入需 ~800 token
    for (let i = 0; i < 5; i++) {
      await writeMemory(FIXED_CWD, {
        name: `topic-${i}`,
        description: `topic ${i} description that is somewhat lengthy`,
        type: "user",
        body: "lorem ipsum dolor sit amet ".repeat(50),
        trust: "verified", // verified 才注入 body snippet,token 多
      });
    }
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const stage = new InjectMemoryStage();

    // 满量(无 contextWindow → scale=1.0)
    const ctxFull = mkCtx({
      messages: [user("topic 1 question")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
    });
    await stage.run(ctxFull);
    const fullLen = ctxFull.systemPrompt.length;

    // 高占用(>80%)→ scale=0.25,maxTokens 降一档
    const heavyPrompt = "x ".repeat(1500);
    const ctxScaled = mkCtx({
      messages: [user("topic 1 question")],
      systemPrompt: heavyPrompt,
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
      contextWindow: 1700,
    });
    await stage.run(ctxScaled);
    // 注入段应短于满量(扣掉 heavyPrompt 长度)
    const scaledInjection = ctxScaled.systemPrompt.length - heavyPrompt.length;
    const fullInjection = fullLen - "BASE".length;
    expect(scaledInjection).toBeLessThan(fullInjection);
  });
});

describe("O5 — 召回输出按 name 字典序(prompt cache 字节稳定)", () => {
  it("同一 query 多次召回输出字节级一致", async () => {
    for (let i = 0; i < 5; i++) {
      await writeMemory(FIXED_CWD, {
        name: `zeta-${i}`,
        description: `zeta entry ${i}`,
        type: "user",
        body: "zeta body",
      });
    }
    await writeMemory(FIXED_CWD, {
      name: "alpha",
      description: "alpha entry",
      type: "user",
      body: "alpha body",
    });
    const embIndex = await buildMemoryIndex(FIXED_CWD);

    const ctx1 = mkCtx({
      messages: [user("entry question")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
    });
    const ctx2 = mkCtx({
      messages: [user("entry question")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
    });
    await new InjectMemoryStage().run(ctx1);
    await new InjectMemoryStage().run(ctx2);

    expect(ctx1.systemPrompt).toBe(ctx2.systemPrompt);
  });

  it("kept 列表按 name 字典序输出 — alpha 出现在 zeta-* 之前", async () => {
    await writeMemory(FIXED_CWD, {
      name: "zeta-only",
      description: "zeta only entry about indentation tabs spaces",
      type: "user",
      body: "zeta",
    });
    await writeMemory(FIXED_CWD, {
      name: "alpha-only",
      description: "alpha only entry about indentation tabs spaces",
      type: "user",
      body: "alpha",
    });
    await writeMemory(FIXED_CWD, {
      name: "mike-only",
      description: "mike only entry about indentation tabs spaces",
      type: "user",
      body: "mike",
    });
    const embIndex = await buildMemoryIndex(FIXED_CWD);
    const ctx = mkCtx({
      messages: [user("indentation tabs spaces")],
      memoryEmbeddingIndex: embIndex,
      memoryEmbeddingTopK: 5,
    });
    await new InjectMemoryStage().run(ctx);
    const idxAlpha = ctx.systemPrompt.indexOf("alpha-only");
    const idxMike = ctx.systemPrompt.indexOf("mike-only");
    const idxZeta = ctx.systemPrompt.indexOf("zeta-only");
    expect(idxAlpha).toBeGreaterThan(0);
    expect(idxMike).toBeGreaterThan(0);
    expect(idxZeta).toBeGreaterThan(0);
    expect(idxAlpha).toBeLessThan(idxMike);
    expect(idxMike).toBeLessThan(idxZeta);
  });
});
