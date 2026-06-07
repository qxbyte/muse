import { describe, it, expect } from "vitest";
import { countText, countMessages, countMessage } from "../../src/preprocess/tokenize.js";
import type { Message, ToolDefinition } from "../../src/types/index.js";

describe("tokenize", () => {
  it("countText returns 0 for empty string", () => {
    expect(countText("")).toBe(0);
  });

  it("countText is positive for non-empty text", () => {
    expect(countText("hello world")).toBeGreaterThan(0);
  });

  it("countText longer text => more tokens", () => {
    const short = countText("hi");
    const long = countText("the quick brown fox jumps over the lazy dog");
    expect(long).toBeGreaterThan(short);
  });

  it("countMessages over string content", () => {
    const msgs: Message[] = [
      { role: "user", content: "explain TypeScript generics" },
    ];
    expect(countMessages(msgs)).toBeGreaterThan(0);
  });

  it("countMessages over ContentPart[] (text/tool_use/file/image)", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "1", name: "Read", args: { file_path: "/tmp/a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "file", path: "src/app.tsx", mimeType: "text/plain", text: "export const x = 1;" },
          { type: "image", path: "screenshot.png", mediaType: "image/png", data: "iVBOR" },
        ],
      },
    ];
    expect(countMessages(msgs)).toBeGreaterThan(0);
  });

  it("countMessages includes systemPrompt", () => {
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    const withoutSys = countMessages(msgs);
    const withSys = countMessages(msgs, "You are a helpful assistant.");
    expect(withSys).toBeGreaterThan(withoutSys);
  });

  it("countMessages includes tool definitions", () => {
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    const tools: ToolDefinition[] = [
      {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];
    expect(countMessages(msgs, undefined, tools)).toBeGreaterThan(countMessages(msgs));
  });

  it("countMessages handles tool role messages", () => {
    const msgs: Message[] = [
      { role: "tool", toolUseId: "1", toolName: "Read", content: "file contents here" },
    ];
    expect(countMessages(msgs)).toBeGreaterThan(0);
  });

  it("countMessage(single) matches countMessages([single])", () => {
    const m: Message = { role: "user", content: "abc" };
    expect(countMessage(m)).toBe(countMessages([m]));
  });
});
