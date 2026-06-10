import { describe, it, expect } from "vitest";
import { Agent } from "../src/loop/agent.js";
import { PermissionGate } from "../src/permission/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LLMClient, LLMEvent, StreamOptions } from "../src/llm/types.js";
import type { Session } from "../src/session/jsonl.js";

/** 测试用 mock session(只接收 append,不真写文件) */
function makeSession(): Session {
  const events: unknown[] = [];
  return {
    meta: { id: "test", cwd: "/tmp", createdAt: "", provider: "test", model: "test" },
    append: async (e: unknown) => {
      events.push(e);
    },
    // 其余 method 测试不用到,留空
  } as unknown as Session;
}

/** 测试用 LLM:每个 stream 慢慢吐 N 段文本 + finish。可被 abort 中断。 */
function makeSlowLLM(chunks: string[], delayMs = 5): LLMClient {
  return {
    providerName: "test",
    model: "test",
    capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
    async *stream(opts: StreamOptions): AsyncIterable<LLMEvent> {
      for (const c of chunks) {
        await new Promise((res) => setTimeout(res, delayMs));
        if (opts.abortSignal?.aborted) {
          // 模拟 fetch 中断:抛 AbortError
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          throw err;
        }
        yield { type: "text", delta: c };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
}

function makeAgent(llm: LLMClient): Agent {
  return new Agent({
    llm,
    tools: new ToolRegistry(),
    permissions: new PermissionGate(),
    session: makeSession(),
    cwd: "/tmp",
    systemPrompt: "test",
  });
}

describe("Agent abort via runTurn(signal)", () => {
  it("completes normally without abort", async () => {
    const agent = makeAgent(makeSlowLLM(["hello", " ", "world"]));
    await agent.runTurn("hi");
    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(2); // user + assistant
    expect(msgs[1].role).toBe("assistant");
    if (msgs[1].role === "assistant") {
      const text = msgs[1].content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toBe("hello world");
    }
  });

  it("aborts mid-stream and keeps partial assistant text with [interrupted] marker", async () => {
    const agent = makeAgent(makeSlowLLM(["aaa", "bbb", "ccc", "ddd"], 10));
    const ctrl = new AbortController();
    // 25ms 后 abort — 期望已流出前 2-3 段;CI 慢机器调度抖动时至少流出 1 段,
    // 仍小于全 4 段总时长 ~40ms,保证不会流完。
    setTimeout(() => ctrl.abort(), 25);
    await agent.runTurn("hi", ctrl.signal);
    const msgs = agent.getMessages();
    // 至少有 user + assistant(可能含 [interrupted] 标识)
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("assistant");
    if (last.role === "assistant") {
      const text = last.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("[interrupted]");
      // 应保留 marker 自身(>=);极端情况(timer 先于首 chunk 触发)允许仅 marker,
      // 关键不变量是"绝不流完所有 4 段"(下一行的 not.toContain)
      expect(text.length).toBeGreaterThanOrEqual("[interrupted]".length);
      expect(text).not.toContain("ddd"); // 最后一段不应到达
    }
  });

  it("respects pre-aborted signal — emits [interrupted] immediately", async () => {
    const agent = makeAgent(makeSlowLLM(["wont", "happen"], 10));
    const ctrl = new AbortController();
    ctrl.abort();
    await agent.runTurn("hi", ctrl.signal);
    const msgs = agent.getMessages();
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("assistant");
    if (last.role === "assistant") {
      const text = last.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("[interrupted]");
    }
  });
});
