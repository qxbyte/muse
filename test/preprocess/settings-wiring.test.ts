/**
 * Settings schema 暴露后,8 个开关接通行为测试。
 *
 * 验证:settings → stage 行为是否正确路由(false 时回退到旧行为 / 默认时新行为)。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TrimHistoryStage } from "../../src/preprocess/request/trim-history.js";
import { InjectMemoryStage } from "../../src/preprocess/request/inject-memory.js";
import type { RequestCtx } from "../../src/preprocess/request/index.js";
import { TodoStore } from "../../src/loop/todos.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { countMessages } from "../../src/preprocess/tokenize.js";
import { compactMessages } from "../../src/loop/context.js";
import type { Message } from "../../src/types/index.js";
import type { LLMClient, LLMEvent, StreamOptions } from "../../src/llm/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemory, listMemories } from "../../src/loop/memory.js";

const FIXED_CWD = "/Users/test/settings-wire-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-settings-wire-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function mkLLM(text: string): LLMClient {
  return {
    providerName: "test",
    model: "test",
    capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
    async *stream(_opts: StreamOptions): AsyncIterable<LLMEvent> {
      yield { type: "text", delta: text } as LLMEvent;
      yield { type: "finish", reason: "stop" } as LLMEvent;
    },
  };
}

function longHistory(): Message[] {
  const msgs: Message[] = [{ role: "user", content: "initial task" }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${i}` }] });
    msgs.push({ role: "user", content: `follow ${i}` });
  }
  return msgs;
}

describe("settings.trimHistory.preserveUserMessages = false → 旧 marker 行为", () => {
  it("false 时被切段全部压成一条 marker,user 消息不保留", () => {
    const makeUser = (label: string): Message => ({
      role: "user",
      content: `${label} ` + "the quick brown fox jumps over the lazy dog. ".repeat(20),
    });
    const makeAsst = (label: string): Message => ({
      role: "assistant",
      content: [{ type: "text", text: `${label} ` + "the quick brown fox. ".repeat(20) }],
    });
    const msgs: Message[] = [makeUser("turn-0")];
    for (let i = 1; i < 20; i++) {
      msgs.push(i % 2 === 1 ? makeAsst(`asst-${i}`) : makeUser(`user-${i}`));
    }
    const totalTokens = countMessages(msgs);
    const contextWindow = Math.floor(totalTokens / 0.8) - 100;

    const stage = new TrimHistoryStage();
    const ctx: RequestCtx = {
      messages: msgs,
      systemPrompt: "",
      tools: [],
      modelId: "t",
      mode: "default",
      cwd: FIXED_CWD,
      settings: { trimHistory: { preserveUserMessages: false } },
      services: { todos: new TodoStore(), memoryIndex: "", toolRegistry: new ToolRegistry(), provider: "t", contextWindow },
    };
    stage.run(ctx);

    // 旧 marker 模式:中间所有 user 消息(user-2/4/6/...)不再以原文出现
    // 应有恰好一条 marker 文案是 "[N earlier messages trimmed to fit context window]"
    const markerMsg = ctx.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && /earlier messages? trimmed/.test(m.content),
    );
    expect(markerMsg).toBeDefined();
    // 原 user-2 / user-4 等不应再以原文出现
    const userContents = ctx.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userContents.some((c) => c.startsWith("user-2"))).toBe(false);
    expect(userContents.some((c) => c.startsWith("user-4"))).toBe(false);
  });
});

describe("settings.trimHistory.targetRatio 可调", () => {
  it("targetRatio=0.3 比默认 0.6 裁得更激进", () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i % 2 === 0 ? `u${i} ` + "x ".repeat(60) : ([{ type: "text" as const, text: `a${i} ` + "x ".repeat(60) }] as Message["content"]),
    }) as Message);
    const totalTokens = countMessages(big);
    const contextWindow = Math.floor(totalTokens / 0.8) - 50;

    const baseCtx = (target: number): RequestCtx => ({
      messages: [...big],
      systemPrompt: "",
      tools: [],
      modelId: "t",
      mode: "default",
      cwd: FIXED_CWD,
      settings: { trimHistory: { targetRatio: target, preserveUserMessages: false } },
      services: { todos: new TodoStore(), memoryIndex: "", toolRegistry: new ToolRegistry(), provider: "t", contextWindow },
    });

    const ctxLoose = baseCtx(0.6);
    new TrimHistoryStage().run(ctxLoose);
    const ctxStrict = baseCtx(0.3);
    new TrimHistoryStage().run(ctxStrict);
    expect(ctxStrict.estimatedTokens!).toBeLessThanOrEqual(ctxLoose.estimatedTokens!);
  });
});

describe("settings.injectMemory.budgetScaleEnabled = false → 锁定满量", () => {
  const bigIndex = Array.from({ length: 220 }, (_, i) => `[auto] - [m${i}](m${i}.md) — e${i}`).join("\n");

  it("budgetScaleEnabled=false 时 budget 100% 满占也不缩量", async () => {
    const heavyPrompt = "x ".repeat(1500);
    const ctx: RequestCtx = {
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: heavyPrompt,
      tools: [],
      modelId: "t",
      mode: "default",
      cwd: FIXED_CWD,
      settings: { injectMemory: { budgetScaleEnabled: false } },
      services: {
        todos: new TodoStore(),
        memoryIndex: bigIndex,
        toolRegistry: new ToolRegistry(),
        provider: "t",
        contextWindow: 1700,
      },
    };
    await new InjectMemoryStage().run(ctx);
    // scale 1.0 ⇒ 截到 DEFAULT_FULL_INDEX_MAX_LINES (200)
    // 关键:m100 / m150 应该都在(scale=0.25 时它们会被截掉)
    expect(ctx.systemPrompt).toContain("m100](m100.md)");
    expect(ctx.systemPrompt).toContain("m150](m150.md)");
  });
});

describe("settings.compact.fallbackOnFormatFail = false → 不降级", () => {
  it("false 时 9-section 失败直接抛错,不重试 6-section", async () => {
    let calls = 0;
    const llm: LLMClient = {
      providerName: "test",
      model: "test",
      capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
      async *stream(_opts: StreamOptions): AsyncIterable<LLMEvent> {
        calls++;
        yield { type: "error", error: new Error("first call fails") } as LLMEvent;
      },
    };
    await expect(
      compactMessages(longHistory(), { llm, cwd: FIXED_CWD, fallbackOnFormatFail: false }),
    ).rejects.toThrow(/first call fails/);
    expect(calls).toBe(1);
  });

  it("true(默认) 时降级 6-section 重试", async () => {
    let calls = 0;
    const llm: LLMClient = {
      providerName: "test",
      model: "test",
      capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
      async *stream(_opts: StreamOptions): AsyncIterable<LLMEvent> {
        calls++;
        if (calls === 1) {
          yield { type: "error", error: new Error("first") } as LLMEvent;
          return;
        }
        yield { type: "text", delta: "fallback ok" } as LLMEvent;
        yield { type: "finish", reason: "stop" } as LLMEvent;
      },
    };
    const result = await compactMessages(longHistory(), { llm, cwd: FIXED_CWD });
    expect(calls).toBe(2);
    expect(result.summary).toContain("fallback ok");
  });
});

describe("settings.compact.dedupPromotedFacts = false → 覆盖写", () => {
  it("false 时同名 memory 会被 promote 覆盖(注意:覆盖会触发 trust 升级语义)", async () => {
    await writeMemory(FIXED_CWD, {
      name: "team-pref",
      description: "原 verified",
      type: "project",
      body: "verified content",
      trust: "verified",
    });
    const llmText = `Summary
\`\`\`json
{"facts":[{"name":"team-pref","type":"project","description":"new auto","body":"new body"}]}
\`\`\``;
    const result = await compactMessages(longHistory(), {
      llm: mkLLM(llmText),
      cwd: FIXED_CWD,
      dedupPromotedFacts: false,
    });
    expect(result.promotedFacts).toHaveLength(1);
    // dedup=false → 走 writeMemory,而 writeMemory 自身 trust 升级语义保留 verified(只升不降)
    expect(result.promotedFacts![0].status).toBe("saved");
    const list = await listMemories(FIXED_CWD);
    const file = list.find((f) => f.frontmatter.name === "team-pref");
    expect(file).toBeDefined();
    // body 已被覆盖(writeMemory 始终更新 body),trust 保留 verified(只升不降)
    expect(file!.body).toContain("new body");
    expect(file!.frontmatter.trust).toBe("verified");
  });

  it("true(默认) 时同名跳过,body 不变", async () => {
    await writeMemory(FIXED_CWD, {
      name: "team-pref",
      description: "原 verified",
      type: "project",
      body: "verified content",
      trust: "verified",
    });
    const llmText = `Summary
\`\`\`json
{"facts":[{"name":"team-pref","type":"project","description":"new auto","body":"new body"}]}
\`\`\``;
    const result = await compactMessages(longHistory(), { llm: mkLLM(llmText), cwd: FIXED_CWD });
    expect(result.promotedFacts![0].status).toBe("skipped");
    const list = await listMemories(FIXED_CWD);
    const file = list.find((f) => f.frontmatter.name === "team-pref");
    expect(file!.body).toContain("verified content");
  });
});

describe("settings.budgetGuard.promoteFactsToMemory = false → 不 promote", () => {
  it("false 时 facts 不写入 memory", async () => {
    const llmText = `Summary
\`\`\`json
{"facts":[{"name":"x","type":"user","description":"d","body":"b"}]}
\`\`\``;
    const result = await compactMessages(longHistory(), {
      llm: mkLLM(llmText),
      cwd: FIXED_CWD,
      promoteFactsToMemory: false,
    });
    expect(result.promotedFacts).toBeUndefined();
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(0);
  });
});
