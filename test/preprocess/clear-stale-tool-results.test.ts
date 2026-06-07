/**
 * I-3 clear-stale-tool-results 测试。
 *
 * 设计文档:模块设计/上下文管理工程/设计.md §4.3。
 */

import { describe, it, expect } from "vitest";
import { clearStaleResults } from "../../src/preprocess/request/clear-stale-tool-results.js";
import type { Message } from "../../src/types/index.js";

function asstTool(id: string, name: string, args: unknown): Message {
  return { role: "assistant", content: [{ type: "tool_use", id, name, args }] };
}
function tool(id: string, content: string): Message {
  return { role: "tool", toolUseId: id, content };
}
function user(t: string): Message {
  return { role: "user", content: t };
}

const CLEAR_DEFAULT = new Set(["Read", "Grep", "Glob"]);

describe("I-3 clear-stale-tool-results", () => {
  it("同一 Read 跑 3 次,最新保留,旧 2 个被清(K=0 用例)", () => {
    const msgs: Message[] = [
      user("read foo"),
      asstTool("r1", "Read", { file_path: "/a.ts" }),
      tool("r1", "content v1"),
      asstTool("r2", "Read", { file_path: "/a.ts" }),
      tool("r2", "content v2"),
      asstTool("r3", "Read", { file_path: "/a.ts" }),
      tool("r3", "content v3"),
    ];
    // keepRecent=0 让所有都候选清(简化测试)
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    expect(toolMsgs[0].content).toMatch(/cleared/);
    expect(toolMsgs[1].content).toMatch(/cleared/);
    expect(toolMsgs[2].content).toBe("content v3");
  });

  it("不同文件的 Read 各自不冲突", () => {
    const msgs: Message[] = [
      asstTool("r1", "Read", { file_path: "/a.ts" }),
      tool("r1", "a content"),
      asstTool("r2", "Read", { file_path: "/b.ts" }),
      tool("r2", "b content"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    expect(toolMsgs[0].content).toBe("a content");
    expect(toolMsgs[1].content).toBe("b content");
  });

  it("Read 后有同文件 Edit → Read 保留(Edit 依赖)", () => {
    const msgs: Message[] = [
      asstTool("r1", "Read", { file_path: "/a.ts" }),
      tool("r1", "old read content"),
      asstTool("e1", "Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }),
      tool("e1", "edited ok"),
      asstTool("r2", "Read", { file_path: "/a.ts" }),
      tool("r2", "new read content"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    // r1 被 Edit 依赖,保留;r2 是最新,也保留;edit 不在清单
    expect(toolMsgs[0].content).toBe("old read content");
    expect(toolMsgs[1].content).toBe("edited ok");
    expect(toolMsgs[2].content).toBe("new read content");
  });

  it("最近 K=3 条不清(即使重复)", () => {
    const msgs: Message[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(asstTool(`r${i}`, "Read", { file_path: "/a.ts" }));
      msgs.push(tool(`r${i}`, `v${i}`));
    }
    const result = clearStaleResults(msgs, 3, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    // r1, r2 被清;r3, r4, r5 保留(最近 3 条)
    expect(toolMsgs[0].content).toMatch(/cleared/);
    expect(toolMsgs[1].content).toMatch(/cleared/);
    expect(toolMsgs[2].content).toBe("v3");
    expect(toolMsgs[3].content).toBe("v4");
    expect(toolMsgs[4].content).toBe("v5");
  });

  it("Bash 类不在清单 → 完全不清", () => {
    const msgs: Message[] = [
      asstTool("b1", "Bash", { command: "ls" }),
      tool("b1", "file list"),
      asstTool("b2", "Bash", { command: "ls" }),
      tool("b2", "file list 2"),
      asstTool("b3", "Bash", { command: "ls" }),
      tool("b3", "file list 3"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    expect(toolMsgs[0].content).toBe("file list");
    expect(toolMsgs[1].content).toBe("file list 2");
    expect(toolMsgs[2].content).toBe("file list 3");
  });

  it("配对完整:清理后 tool message 仍存在(只改 content)", () => {
    const msgs: Message[] = [
      asstTool("r1", "Grep", { pattern: "foo" }),
      tool("r1", "result 1"),
      asstTool("r2", "Grep", { pattern: "foo" }),
      tool("r2", "result 2"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    // 长度不变
    expect(result.length).toBe(msgs.length);
    // r1 toolMessage 还在,只 content 变了
    const r1 = result[1] as { role: "tool"; toolUseId: string; content: string };
    expect(r1.role).toBe("tool");
    expect(r1.toolUseId).toBe("r1");
    expect(r1.content).toMatch(/cleared/);
  });

  it("不同参数(args 不同)即使工具名相同也算不同 key", () => {
    const msgs: Message[] = [
      asstTool("g1", "Grep", { pattern: "foo" }),
      tool("g1", "found foo"),
      asstTool("g2", "Grep", { pattern: "bar" }),
      tool("g2", "found bar"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const toolMsgs = result.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    expect(toolMsgs[0].content).toBe("found foo");
    expect(toolMsgs[1].content).toBe("found bar");
  });

  it("被清的 tool result 文案含 placeholder + 原 size + latest msgIdx", () => {
    const msgs: Message[] = [
      asstTool("r1", "Read", { file_path: "/a.ts" }),
      tool("r1", "the original content here"),
      asstTool("r2", "Read", { file_path: "/a.ts" }),
      tool("r2", "v2"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    const cleared = result[1] as { content: string };
    expect(cleared.content).toContain("cleared");
    expect(cleared.content).toContain("Read");
    expect(cleared.content).toContain("/a.ts");
    expect(cleared.content).toMatch(/Original size: \d+B/);
  });

  it("无可清场景 → 原数组引用返回", () => {
    const msgs: Message[] = [
      asstTool("r1", "Read", { file_path: "/a.ts" }),
      tool("r1", "content"),
    ];
    const result = clearStaleResults(msgs, 0, CLEAR_DEFAULT);
    expect(result).toBe(msgs);
  });
});
