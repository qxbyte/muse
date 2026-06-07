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

  it("trims when over 0.8 × budget; keeps initial user + adds marker", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) msgs.push(makeLongUserMessage(`turn-${i}`, 20));
    const originalLen = msgs.length;
    const totalTokens = countMessages(msgs);
    // budget 取 totalTokens 的 ~80%,确保超 0.8 阈值
    const contextWindow = Math.floor(totalTokens / 0.8) - 100;
    const ctx = mkCtx(msgs, { contextWindow });
    stage.run(ctx);
    // 1) 确实裁了 — message 数 < 原始
    expect(ctx.messages.length).toBeLessThan(originalLen);
    // 2) 第一条保留 turn-0
    const first = ctx.messages[0];
    expect(first.role).toBe("user");
    if (typeof first.content === "string") {
      expect(first.content.startsWith("turn-0")).toBe(true);
    }
    // 3) 第二条是 trim marker
    const marker = ctx.messages[1];
    expect(marker.role).toBe("user");
    if (typeof marker.content === "string") {
      expect(marker.content).toContain("trimmed");
    }
    // 4) trim 后估算降了
    expect(ctx.estimatedTokens!).toBeLessThan(totalTokens);
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
});
