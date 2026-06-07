import { describe, it, expect, vi } from "vitest";
import { BudgetGuardStage, BudgetExceededError } from "../../src/preprocess/request/budget-guard.js";
import type { RequestCtx } from "../../src/preprocess/request/index.js";
import type { Message } from "../../src/types/index.js";
import { TodoStore } from "../../src/loop/todos.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function mkCtx(opts: Partial<{
  messages: Message[];
  contextWindow: number;
  enabled: boolean;
  budgetRatio: number;
  estimatedTokens: number;
  compact: (signal?: AbortSignal) => Promise<Message[]>;
}> = {}): RequestCtx {
  return {
    messages: opts.messages ?? [{ role: "user", content: "hi" }],
    systemPrompt: "",
    tools: [],
    modelId: "test-model",
    mode: "default",
    cwd: "/tmp",
    estimatedTokens: opts.estimatedTokens,
    settings: {
      budgetGuard: {
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
      compact: opts.compact,
    },
  };
}

describe("BudgetGuardStage", () => {
  const stage = new BudgetGuardStage();

  it("skips when contextWindow not configured", () => {
    const ctx = mkCtx();
    expect(stage.skip(ctx)).toBe(true);
  });

  it("skips when explicitly disabled", () => {
    const ctx = mkCtx({ contextWindow: 1000, enabled: false });
    expect(stage.skip(ctx)).toBe(true);
  });

  it("no-op when estimatedTokens under 0.95 budget", async () => {
    const compact = vi.fn();
    const ctx = mkCtx({ contextWindow: 1000, estimatedTokens: 100, compact });
    await stage.run(ctx);
    expect(compact).not.toHaveBeenCalled();
  });

  it("throws BudgetExceededError when over 0.95 and no compact configured", async () => {
    const ctx = mkCtx({ contextWindow: 1000, estimatedTokens: 980 });
    await expect(stage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("triggers compact when over 0.95; replaces ctx.messages on success", async () => {
    const compacted: Message[] = [{ role: "user", content: "summary" }];
    const compact = vi.fn().mockResolvedValue(compacted);
    const ctx = mkCtx({ contextWindow: 1000, estimatedTokens: 980, compact });
    await stage.run(ctx);
    expect(compact).toHaveBeenCalledOnce();
    expect(ctx.messages).toBe(compacted);
    expect(ctx.estimatedTokens!).toBeLessThan(1000 * 0.95);
  });

  it("wraps compact error into BudgetExceededError", async () => {
    const compact = vi.fn().mockRejectedValue(new Error("LLM down"));
    const ctx = mkCtx({ contextWindow: 1000, estimatedTokens: 980, compact });
    await expect(stage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("throws BudgetExceededError when compact succeeds but result is still over budget", async () => {
    // compact 返回的 messages 仍然非常长 — 模拟 "压不下来" 场景
    const longContent = "the quick brown fox jumps over the lazy dog. ".repeat(500);
    const compacted: Message[] = [{ role: "user", content: longContent }];
    const compact = vi.fn().mockResolvedValue(compacted);
    const ctx = mkCtx({ contextWindow: 100, estimatedTokens: 200, compact });
    await expect(stage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("computes estimatedTokens on-the-fly if upstream didn't write it", async () => {
    const compact = vi.fn().mockResolvedValue([{ role: "user", content: "short" } as Message]);
    // 不预设 estimatedTokens,让 stage 自己算
    const longMsg: Message = { role: "user", content: "abc def ghi jkl ".repeat(200) };
    const ctx = mkCtx({ contextWindow: 100, messages: [longMsg], compact });
    await stage.run(ctx);
    expect(compact).toHaveBeenCalledOnce();
  });
});
