import { describe, it, expect } from "vitest";
import { Agent } from "../src/loop/agent.js";
import { PermissionGate } from "../src/permission/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LLMClient, LLMEvent, StreamOptions } from "../src/llm/types.js";
import type { Session } from "../src/session/jsonl.js";

function makeSession(): Session {
  const events: unknown[] = [];
  return {
    meta: { id: "test", cwd: "/tmp", createdAt: "", provider: "test", model: "test" },
    append: async (e: unknown) => {
      events.push(e);
    },
  } as unknown as Session;
}

/**
 * 测试用 LLM:每轮 stream 吐一段固定 text + finish=stop。
 * 通过外部 round 计数让连续两轮看出区别(stream 1 vs 2),便于断言 messages 顺序。
 */
function makeRoundLLM(): LLMClient & { rounds: number } {
  const llm = {
    providerName: "test",
    model: "test",
    capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
    rounds: 0,
    async *stream(_opts: StreamOptions): AsyncIterable<LLMEvent> {
      llm.rounds++;
      await new Promise((res) => setTimeout(res, 5));
      yield { type: "text", delta: `ack-${llm.rounds}` } as LLMEvent;
      yield { type: "finish", reason: "stop" } as LLMEvent;
    },
  } as LLMClient & { rounds: number };
  return llm;
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

describe("Agent guidance queue", () => {
  it("enqueued guidance is injected as user message before next stream + extends turn", async () => {
    const llm = makeRoundLLM();
    const agent = makeAgent(llm);

    // stream 启动后立刻(2ms,在 stream 的 5ms await 期间)塞一段 guidance。
    // 第一轮 stream 跑完时 toolCallsToRun=0 + pendingGuidance 非空 → continue;
    // 下一轮 flushGuidance 把它注入成 user message → 再跑第二轮 stream。
    setTimeout(() => agent.enqueueGuidance("more please"), 2);

    await agent.runTurn("hi");

    const msgs = agent.getMessages();
    // 期望:user("hi") + assistant("ack-1") + user("more please") + assistant("ack-2")
    expect(msgs).toHaveLength(4);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
    expect(msgs[3].role).toBe("assistant");

    // 注入的 user msg 内容必须是 "more please"
    const injected = msgs[2];
    if (injected.role === "user" && Array.isArray(injected.content)) {
      const text = injected.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toBe("more please");
    } else {
      throw new Error("guidance not injected as user content[]");
    }

    // 两轮 stream 都应该跑过
    expect(llm.rounds).toBe(2);
    expect(agent.getPendingGuidanceCount()).toBe(0);
  });

  it("clearGuidance drops queued items without injecting", async () => {
    const llm = makeRoundLLM();
    const agent = makeAgent(llm);

    setTimeout(() => {
      agent.enqueueGuidance("will be cleared");
      agent.clearGuidance();
    }, 2);

    await agent.runTurn("hi");

    const msgs = agent.getMessages();
    // 只走一轮:user + assistant
    expect(msgs).toHaveLength(2);
    expect(llm.rounds).toBe(1);
    expect(agent.getPendingGuidanceCount()).toBe(0);
  });

  it("multiple queued items merged into single user message with separators", async () => {
    const llm = makeRoundLLM();
    const agent = makeAgent(llm);

    // 在 stream 跑期间塞两条;两条都该在下一轮注入前合并成一条 user message
    setTimeout(() => {
      agent.enqueueGuidance("first note");
      agent.enqueueGuidance("second note");
    }, 2);

    await agent.runTurn("hi");

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(4);
    const injected = msgs[2];
    if (injected.role === "user" && Array.isArray(injected.content)) {
      const text = injected.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("first note");
      expect(text).toContain("second note");
      expect(text).toContain("---"); // 分隔符
    } else {
      throw new Error("guidance not injected as user content[]");
    }
  });

  it("onGuidanceInjected event fires with merged parts", async () => {
    const llm = makeRoundLLM();
    let injectedParts: unknown = null;
    const agent = new Agent({
      llm,
      tools: new ToolRegistry(),
      permissions: new PermissionGate(),
      session: makeSession(),
      cwd: "/tmp",
      systemPrompt: "test",
      events: {
        onGuidanceInjected: (parts) => {
          injectedParts = parts;
        },
      },
    });

    setTimeout(() => agent.enqueueGuidance("hi from guide"), 2);
    await agent.runTurn("first");

    expect(injectedParts).not.toBeNull();
    expect(Array.isArray(injectedParts)).toBe(true);
  });
});
