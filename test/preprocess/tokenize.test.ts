import { describe, it, expect, afterEach } from "vitest";
import {
  countText,
  countMessages,
  countMessage,
  setImageTokenEstimate,
  getImageTokenEstimate,
} from "../../src/preprocess/tokenize.js";
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

  describe("O2 image token estimate (conservative constant)", () => {
    afterEach(() => setImageTokenEstimate(1500));

    it("defaults to 1500 token per image", () => {
      expect(getImageTokenEstimate()).toBe(1500);
    });

    it("一张 image 远高于纯文本占位估算 (旧实装的 ~8 token 已废)", () => {
      const text: Message[] = [{ role: "user", content: "hello" }];
      const withImage: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", path: "screenshot.png", mediaType: "image/png", data: "iVBOR" },
          ],
        },
      ];
      const textTokens = countMessages(text);
      const imageTokens = countMessages(withImage);
      // 一张 image 至少 +1000 token,远大于 text-only
      expect(imageTokens - textTokens).toBeGreaterThan(1000);
    });

    it("setImageTokenEstimate 可改运行时常量", () => {
      setImageTokenEstimate(500);
      const msgs: Message[] = [
        { role: "user", content: [{ type: "image", path: "a.png", mediaType: "image/png", data: "x" }] },
      ];
      const t1 = countMessages(msgs);
      setImageTokenEstimate(2000);
      const t2 = countMessages(msgs);
      // 改大常量,token 数也随之变大(差值约 1500)
      expect(t2 - t1).toBeGreaterThan(1000);
    });

    it("setImageTokenEstimate 拒非法值(保留旧值)", () => {
      setImageTokenEstimate(800);
      expect(getImageTokenEstimate()).toBe(800);
      setImageTokenEstimate(-1);
      expect(getImageTokenEstimate()).toBe(800);
      setImageTokenEstimate(NaN);
      expect(getImageTokenEstimate()).toBe(800);
    });
  });
});
