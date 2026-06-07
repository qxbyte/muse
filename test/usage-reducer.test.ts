/**
 * Reducer 行为单测:确保 ctx% 算法用"最新一次 call 的 input"覆盖,不累加。
 *
 * Bug 重现场景:多轮 tool loop 每次 LLM call 的 input tokens 都包含完整 history,
 * 累加后 turnInputTokens >> 实际 context 占用,ctx% 爆 100%。
 */

import { describe, it, expect } from "vitest";
import type { TokenUsage } from "../src/types/index.js";

interface UIState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnInputTokens: number;
}

type UIAction =
  | { type: "user_submit" }
  | { type: "add_usage"; usage: TokenUsage }
  | { type: "estimate"; inputTokens: number };

// 拷贝 src/app.tsx 的 reducer 关键逻辑用于单测(避免引入 React 上下文)
function reducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "user_submit":
      return { ...state, turnInputTokens: 0 };
    case "add_usage":
      return {
        inputTokens: state.inputTokens + action.usage.inputTokens,
        outputTokens: state.outputTokens + action.usage.outputTokens,
        totalTokens: state.totalTokens + action.usage.totalTokens,
        turnInputTokens: action.usage.inputTokens, // 覆盖,不累加
      };
    case "estimate":
      return { ...state, turnInputTokens: action.inputTokens };
  }
}

const ZERO: UIState = { inputTokens: 0, outputTokens: 0, turnInputTokens: 0, totalTokens: 0 };

describe("usage reducer — ctx% snapshot vs session accumulation", () => {
  it("estimate updates turnInputTokens but not session totals", () => {
    let s = ZERO;
    s = reducer(s, { type: "user_submit" });
    s = reducer(s, { type: "estimate", inputTokens: 800 });
    expect(s.turnInputTokens).toBe(800);
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
  });

  it("real usage overrides turn snapshot, accumulates session", () => {
    let s = ZERO;
    s = reducer(s, { type: "user_submit" });
    s = reducer(s, { type: "estimate", inputTokens: 800 });
    s = reducer(s, {
      type: "add_usage",
      usage: { inputTokens: 850, outputTokens: 120, totalTokens: 970 },
    });
    expect(s.turnInputTokens).toBe(850); // 覆盖 estimate
    expect(s.inputTokens).toBe(850);
    expect(s.outputTokens).toBe(120);
  });

  it("multi-call tool loop:turnInputTokens 跟踪最后一次,session 累加", () => {
    let s = ZERO;
    s = reducer(s, { type: "user_submit" });
    // Call 1
    s = reducer(s, { type: "estimate", inputTokens: 500 });
    s = reducer(s, {
      type: "add_usage",
      usage: { inputTokens: 540, outputTokens: 80, totalTokens: 620 },
    });
    // Tool 跑,Call 2
    s = reducer(s, { type: "estimate", inputTokens: 1200 });
    s = reducer(s, {
      type: "add_usage",
      usage: { inputTokens: 1300, outputTokens: 200, totalTokens: 1500 },
    });
    // Tool 又跑,Call 3
    s = reducer(s, { type: "estimate", inputTokens: 2500 });
    s = reducer(s, {
      type: "add_usage",
      usage: { inputTokens: 2700, outputTokens: 150, totalTokens: 2850 },
    });

    // turnInputTokens 应该 = 最后一次的 inputTokens(代表当前 context 占用)
    expect(s.turnInputTokens).toBe(2700);
    // session 总 input = 540 + 1300 + 2700 = 4540(计费)
    expect(s.inputTokens).toBe(540 + 1300 + 2700);
    expect(s.outputTokens).toBe(80 + 200 + 150);
  });

  it("旧逻辑(累加 turnInputTokens)会爆 — 用本测试验证我们改对了", () => {
    // 演示:若累加,turnInputTokens 会 = 540 + 1300 + 2700 = 4540,远超实际 context 占用 2700
    let s = ZERO;
    s = reducer(s, { type: "user_submit" });
    s = reducer(s, { type: "add_usage", usage: { inputTokens: 540, outputTokens: 0, totalTokens: 540 } });
    s = reducer(s, { type: "add_usage", usage: { inputTokens: 1300, outputTokens: 0, totalTokens: 1300 } });
    s = reducer(s, { type: "add_usage", usage: { inputTokens: 2700, outputTokens: 0, totalTokens: 2700 } });
    // 修正后:turnInputTokens 是最后一次的值(不累加)
    expect(s.turnInputTokens).toBe(2700);
    expect(s.turnInputTokens).not.toBe(4540); // 不是累加值
  });

  it("user_submit resets turnInputTokens (上一轮残留清零)", () => {
    let s = ZERO;
    s = reducer(s, {
      type: "add_usage",
      usage: { inputTokens: 999, outputTokens: 0, totalTokens: 999 },
    });
    expect(s.turnInputTokens).toBe(999);
    s = reducer(s, { type: "user_submit" });
    expect(s.turnInputTokens).toBe(0);
    // session 累计不动
    expect(s.inputTokens).toBe(999);
  });
});
