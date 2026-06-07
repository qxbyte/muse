/**
 * I-2 9 节 schema + I-5 compact → memory 联动测试。
 *
 * 覆盖:
 *   - prompt 模板包含 9 / 6 节标志
 *   - extractFacts 解析 JSON 块(含错误兜底)
 *   - stripFactsBlock 剥掉 facts 部分,只留摘要主体
 *   - compactMessages 在 cwd 提供时 promote facts → memory(trust=auto, source=compact-promote)
 *   - 无 cwd / promoteFactsToMemory=false 时不 promote
 *   - PromotedFact status:saved / blocked(hook block)/ failed
 *   - apply-mode-filter plan 模式下 MemoryRead/MemoryWrite 仍可见
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSummaryPrompt,
  extractFacts,
  stripFactsBlock,
} from "../src/loop/prompts/summarize.js";
import { compactMessages } from "../src/loop/context.js";
import { listMemories, readMemory } from "../src/loop/memory.js";
import { ApplyModeFilterStage } from "../src/preprocess/request/apply-mode-filter.js";
import type { RequestCtx } from "../src/preprocess/request/index.js";
import { TodoStore } from "../src/loop/todos.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { BUILTIN_TOOLS } from "../src/tools/builtin/index.js";
import type { LLMClient, LLMEvent, StreamOptions } from "../src/llm/types.js";
import type { Message } from "../src/types/index.js";

const FIXED_CWD = "/Users/test/compact-promote-proj";
let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-compact-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function makeLLM(summaryText: string): LLMClient {
  return {
    providerName: "test",
    model: "test",
    capabilities: { toolCalling: false, parallelToolCalls: false, vision: false, jsonMode: false, maxContextWindow: 0 },
    async *stream(_opts: StreamOptions): AsyncIterable<LLMEvent> {
      yield { type: "text", delta: summaryText } as LLMEvent;
      yield { type: "finish", reason: "stop" } as LLMEvent;
    },
  };
}

function user(t: string): Message {
  return { role: "user", content: t };
}
function asst(t: string): Message {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}

function longHistory(): Message[] {
  const msgs: Message[] = [user("initial task")];
  for (let i = 0; i < 12; i++) {
    msgs.push(asst(`step ${i}`));
    msgs.push(user(`follow ${i}`));
  }
  return msgs;
}

describe("I-2 — buildSummaryPrompt", () => {
  it("9-section 含 9 个编号 + 'All user messages' sacred 提示", () => {
    const p = buildSummaryPrompt("hi", "9-section");
    expect(p).toMatch(/1\.\s+\*\*Primary Request/);
    expect(p).toMatch(/6\.\s+\*\*All user messages/);
    expect(p).toMatch(/9\.\s+\*\*Optional Next Step/);
    expect(p).toMatch(/Sacred section/i);
  });

  it("6-section 含 6 个编号 + 用户消息 sacred 节", () => {
    const p = buildSummaryPrompt("hi", "6-section");
    expect(p).toMatch(/1\.\s+\*\*Primary Request/);
    expect(p).toMatch(/5\.\s+\*\*All user messages/);
    expect(p).toMatch(/6\.\s+\*\*Current Work/);
    expect(p).not.toMatch(/7\.\s+/);
  });

  it("含 facts_to_promote JSON 模板与强约束", () => {
    const p = buildSummaryPrompt("hi", "9-section");
    expect(p).toContain("Extracted Facts for Long-term Memory");
    expect(p).toContain("cross-session value");
    expect(p).toContain("over-eager extraction");
  });
});

describe("I-2 — extractFacts", () => {
  it("解析有效 JSON 块", () => {
    const text = `Some summary
\`\`\`json
{
  "facts": [
    { "name": "user-tabs", "type": "feedback", "description": "Tab indent", "body": "User prefers tabs." }
  ]
}
\`\`\``;
    const facts = extractFacts(text);
    expect(facts).toHaveLength(1);
    expect(facts[0].name).toBe("user-tabs");
    expect(facts[0].type).toBe("feedback");
  });

  it("无 JSON 块返空数组", () => {
    expect(extractFacts("just summary text")).toEqual([]);
  });

  it("JSON 格式错返空数组", () => {
    const text = "```json\n{invalid json}\n```";
    expect(extractFacts(text)).toEqual([]);
  });

  it("facts 数组中无效条跳过(缺字段 / type 错 / name 含特殊字符)", () => {
    const text = `\`\`\`json
{
  "facts": [
    { "name": "ok", "type": "user", "description": "d", "body": "b" },
    { "name": "", "type": "user", "description": "d", "body": "b" },
    { "name": "bad/slash", "type": "user", "description": "d", "body": "b" },
    { "name": "wrong-type", "type": "INVALID", "description": "d", "body": "b" },
    { "name": "no-body", "type": "user", "description": "d" }
  ]
}
\`\`\``;
    const facts = extractFacts(text);
    expect(facts.map((f) => f.name)).toEqual(["ok"]);
  });

  it("重复 name 后写覆盖前", () => {
    const text = `\`\`\`json
{
  "facts": [
    { "name": "x", "type": "user", "description": "v1", "body": "b1" },
    { "name": "x", "type": "user", "description": "v2", "body": "b2" }
  ]
}
\`\`\``;
    const facts = extractFacts(text);
    expect(facts).toHaveLength(1);
    expect(facts[0].description).toBe("v2");
  });
});

describe("I-2 — stripFactsBlock", () => {
  it("剥掉 facts JSON 块", () => {
    const text = `Summary body here.\n\n\`\`\`json\n{"facts": [{}]}\n\`\`\``;
    expect(stripFactsBlock(text)).toBe("Summary body here.");
  });

  it("非 facts 的代码块(如 markdown 用例)保留", () => {
    const text = `Summary\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
    const out = stripFactsBlock(text);
    expect(out).toContain("const x = 1;");
  });

  it("无 facts 块时原样返回", () => {
    expect(stripFactsBlock("plain summary")).toBe("plain summary");
  });
});

describe("I-5 — compactMessages 联动 memory", () => {
  it("有 cwd 时 facts 自动写入 memory(trust=auto, source=compact-promote)", async () => {
    const llmText = `# Conversation Summary
1. Primary: do X
6. All user messages: ...

\`\`\`json
{
  "facts": [
    { "name": "team-uses-pnpm", "type": "project", "description": "团队用 pnpm", "body": "Use pnpm not npm." }
  ]
}
\`\`\``;
    const llm = makeLLM(llmText);
    const result = await compactMessages(longHistory(), { llm, cwd: FIXED_CWD });
    expect(result.noop).toBe(false);
    expect(result.promotedFacts).toBeDefined();
    expect(result.promotedFacts).toHaveLength(1);
    expect(result.promotedFacts![0].status).toBe("saved");

    // 验证落盘
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.name).toBe("team-uses-pnpm");
    expect(list[0].frontmatter.trust).toBe("auto");
    expect(list[0].frontmatter.source).toBe("compact-promote");

    // 摘要主体不含 facts JSON
    expect(result.summary).not.toContain('"facts"');
  });

  it("无 cwd 时不 promote(facts 解析跳过)", async () => {
    const llmText = `Summary\n\n\`\`\`json\n{"facts":[{"name":"x","type":"user","description":"d","body":"b"}]}\n\`\`\``;
    const llm = makeLLM(llmText);
    const result = await compactMessages(longHistory(), { llm });
    expect(result.promotedFacts).toBeUndefined();
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(0);
  });

  it("promoteFactsToMemory=false 时不 promote", async () => {
    const llmText = `Summary\n\n\`\`\`json\n{"facts":[{"name":"x","type":"user","description":"d","body":"b"}]}\n\`\`\``;
    const llm = makeLLM(llmText);
    const result = await compactMessages(longHistory(), { llm, cwd: FIXED_CWD, promoteFactsToMemory: false });
    expect(result.promotedFacts).toBeUndefined();
    const list = await listMemories(FIXED_CWD);
    expect(list).toHaveLength(0);
  });

  it("空 facts JSON 时 promotedFacts 为 undefined", async () => {
    const llmText = `Summary\n\n\`\`\`json\n{"facts":[]}\n\`\`\``;
    const llm = makeLLM(llmText);
    const result = await compactMessages(longHistory(), { llm, cwd: FIXED_CWD });
    expect(result.promotedFacts).toBeUndefined();
  });

  it("摘要 message 包成 user role + 标题", async () => {
    const llmText = `Summary content here.`;
    const llm = makeLLM(llmText);
    const result = await compactMessages(longHistory(), { llm, cwd: FIXED_CWD });
    const first = result.newMessages[0];
    expect(first.role).toBe("user");
    expect(typeof first.content === "string" && first.content).toContain("[Previous conversation summary]");
  });
});

describe("I-5 — apply-mode-filter MemoryWrite/Read 白名单", () => {
  function mkPlanCtx(): RequestCtx {
    const registry = new ToolRegistry();
    registry.registerAll(BUILTIN_TOOLS);
    return {
      messages: [],
      systemPrompt: "",
      tools: [],
      modelId: "test",
      mode: "plan",
      cwd: FIXED_CWD,
      settings: {},
      services: {
        todos: new TodoStore(),
        memoryIndex: "",
        toolRegistry: registry,
        provider: "test",
      },
    };
  }

  it("plan 模式下 MemoryRead 和 MemoryWrite 都在 tool list", () => {
    const stage = new ApplyModeFilterStage();
    const ctx = mkPlanCtx();
    stage.run(ctx);
    const names = ctx.tools.map((t) => t.name);
    expect(names).toContain("MemoryRead");
    expect(names).toContain("MemoryWrite");
    // 同时 read 类工具应该在
    expect(names).toContain("Read");
    // write 类(非 memory)不在
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Bash");
  });

  it("非 plan 模式不过滤,全工具可见", () => {
    const stage = new ApplyModeFilterStage();
    const ctx = mkPlanCtx();
    ctx.mode = "default";
    stage.run(ctx);
    const names = ctx.tools.map((t) => t.name);
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("MemoryWrite");
  });
});
