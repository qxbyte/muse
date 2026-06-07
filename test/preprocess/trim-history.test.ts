import { describe, it, expect } from "vitest";
import { TrimHistoryStage } from "../../src/preprocess/request/trim-history.js";
import type { RequestCtx } from "../../src/preprocess/request/index.js";
import type { Message } from "../../src/types/index.js";
import { TodoStore } from "../../src/loop/todos.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { countMessages } from "../../src/preprocess/tokenize.js";

function mkCtx(messages: Message[], opts: Partial<{
  contextWindow: number;
  enabled: boolean;
  budgetRatio: number;
}> = {}): RequestCtx {
  return {
    messages,
    systemPrompt: "",
    tools: [],
    modelId: "test-model",
    mode: "default",
    cwd: "/tmp",
    settings: {
      trimHistory: {
        enabled: opts.enabled,
        budgetRatio: opts.budgetRatio,
      },
    },
    services: {
      todos: new TodoStore(),
      memoryIndex: "",
      toolRegistry: new ToolRegistry(),
      provider: "test",
      contextWindow: opts.contextWindow,
    },
  };
}

function makeLongUserMessage(label: string, repeat = 200): Message {
  return { role: "user", content: `${label} ` + "the quick brown fox jumps over the lazy dog. ".repeat(repeat) };
}

function makeLongAssistantMessage(label: string, repeat = 200): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: `${label} ` + "the quick brown fox jumps over the lazy dog. ".repeat(repeat) }],
  };
}

describe("TrimHistoryStage", () => {
  const stage = new TrimHistoryStage();

  it("skips when contextWindow not configured", () => {
    const ctx = mkCtx([{ role: "user", content: "hi" }]);
    expect(stage.skip(ctx)).toBe(true);
  });

  it("skips when explicitly disabled", () => {
    const ctx = mkCtx([{ role: "user", content: "hi" }], { contextWindow: 1000, enabled: false });
    expect(stage.skip(ctx)).toBe(true);
  });

  it("no-op when under budget; writes estimatedTokens", () => {
    const ctx = mkCtx([{ role: "user", content: "hi" }], { contextWindow: 1000 });
    expect(stage.skip(ctx)).toBe(false);
    stage.run(ctx);
    expect(ctx.estimatedTokens).toBeGreaterThan(0);
    expect(ctx.messages.length).toBe(1);
  });

  it("trims when over 0.8 × budget; keeps initial user + adds marker (I-1: user 消息原文保留)", () => {
    // 注意:I-1 用户消息保护后,中间段全是 user 会导致 trim 无效(因 user 全保);
    // 这里构造 user 与 assistant 交替,assistant 被压成 marker,user 全部保留
    const msgs: Message[] = [makeLongUserMessage("turn-0", 20)];
    for (let i = 1; i < 20; i++) {
      if (i % 2 === 1) msgs.push(makeLongAssistantMessage(`asst-${i}`, 20));
      else msgs.push(makeLongUserMessage(`user-${i}`, 20));
    }
    const originalLen = msgs.length;
    const totalTokens = countMessages(msgs);
    const contextWindow = Math.floor(totalTokens / 0.8) - 100;
    const ctx = mkCtx(msgs, { contextWindow });
    stage.run(ctx);
    // 1) 确实裁了 — assistant 被压,user 全保
    expect(ctx.messages.length).toBeLessThan(originalLen);
    // 2) 第一条保留 turn-0
    const first = ctx.messages[0];
    expect(first.role).toBe("user");
    if (typeof first.content === "string") {
      expect(first.content.startsWith("turn-0")).toBe(true);
    }
    // 3) marker 一定出现且文案含 "trimmed"
    const markerMsg = ctx.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[System note:"),
    );
    expect(markerMsg).toBeDefined();
    expect((markerMsg!.content as string)).toContain("trimmed");
    // 4) trim 后估算降了
    expect(ctx.estimatedTokens!).toBeLessThan(totalTokens);
    // 5) I-1 关键不变量:所有原始 user 消息内容都还在(无丢失)
    const originalUserTexts = msgs
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    const trimmedUserTexts = ctx.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    for (const orig of originalUserTexts) {
      expect(trimmedUserTexts).toContain(orig);
    }
  });

  it("does not break when messages too few", () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const ctx = mkCtx(msgs, { contextWindow: 5 }); // 极小 budget 触发
    stage.run(ctx);
    // 太少没法裁,原样返回
    expect(ctx.messages).toEqual(msgs);
  });

  it("respects custom budgetRatio", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) msgs.push(makeLongUserMessage(`turn-${i}`));
    // budgetRatio 0.99 = 几乎到顶才裁 — 总 token < budget × 0.99 时不动
    const ctx = mkCtx(msgs, { contextWindow: 100000, budgetRatio: 0.99 });
    const originalLen = msgs.length;
    stage.run(ctx);
    expect(ctx.messages.length).toBe(originalLen);
  });

  it("I-1: 被 cutoff 段全是 assistant 时,marker 文案报告 N assistant turns,0 user", () => {
    // 构造:initial user + 12 个 assistant + recent user + 4 assistant
    const msgs: Message[] = [makeLongUserMessage("initial", 20)];
    for (let i = 0; i < 12; i++) msgs.push(makeLongAssistantMessage(`mid-asst-${i}`, 20));
    msgs.push(makeLongUserMessage("recent", 20));
    for (let i = 0; i < 4; i++) msgs.push(makeLongAssistantMessage(`recent-asst-${i}`, 20));
    const totalTokens = countMessages(msgs);
    const ctx = mkCtx(msgs, { contextWindow: Math.floor(totalTokens / 0.8) - 100 });
    stage.run(ctx);
    // marker 应该报告 assistant turns 但不会说 "user messages preserved"(因为中间段没有 user)
    const markerMsg = ctx.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && (m.content as string).startsWith("[System note:"),
    );
    expect(markerMsg).toBeDefined();
    const markerText = markerMsg!.content as string;
    expect(markerText).toMatch(/assistant turn/);
    expect(markerText).not.toMatch(/user message/);
  });

  it("I-1: user 消息含 image / file part 时整体原样保留(part 不变)", () => {
    const imgUser: Message = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", path: "/tmp/foo.png", mediaType: "image/png" },
      ],
    };
    const fileUser: Message = {
      role: "user",
      content: [
        { type: "text", text: "and this" },
        { type: "file", path: "/tmp/data.json", mediaType: "application/json" },
      ],
    };
    const msgs: Message[] = [makeLongUserMessage("initial", 20)];
    msgs.push(makeLongAssistantMessage("a1", 20));
    msgs.push(imgUser);
    msgs.push(makeLongAssistantMessage("a2", 20));
    msgs.push(fileUser);
    for (let i = 0; i < 8; i++) msgs.push(makeLongAssistantMessage(`pad-${i}`, 20));
    msgs.push(makeLongUserMessage("recent", 20));
    for (let i = 0; i < 4; i++) msgs.push(makeLongAssistantMessage(`recent-${i}`, 20));
    const totalTokens = countMessages(msgs);
    const ctx = mkCtx(msgs, { contextWindow: Math.floor(totalTokens / 0.8) - 100 });
    stage.run(ctx);
    // multimodal user 必须**整体引用相等**地出现在 trimmed 里(同对象引用,part 不变)
    expect(ctx.messages).toContain(imgUser);
    expect(ctx.messages).toContain(fileUser);
  });
});
