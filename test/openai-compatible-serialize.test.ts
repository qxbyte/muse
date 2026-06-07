import { describe, it, expect } from "vitest";
import { convertUserParts } from "../src/llm/providers/openai-compatible.js";
import type { ContentPart } from "../src/types/index.js";

describe("convertUserParts (OpenAI-compatible user content serialization)", () => {
  it("all-text parts → string (concat with \\n\\n)", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    const out = convertUserParts(parts);
    expect(out).toBe("hello\n\nworld");
  });

  it("file part → downgrades to XML-wrapped text part", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "review please" },
      { type: "file", path: "/tmp/foo.ts", mimeType: "text/x-typescript", text: "const x = 1" },
    ];
    const out = convertUserParts(parts);
    // 全 text → 返回字符串
    expect(typeof out).toBe("string");
    if (typeof out === "string") {
      expect(out).toContain("review please");
      expect(out).toContain(`<file path="/tmp/foo.ts" mimeType="text/x-typescript">`);
      expect(out).toContain("const x = 1");
      expect(out).toContain("</file>");
    }
  });

  it("image part → SDK ImagePart {type:'image', image:base64, mimeType}", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "what is this" },
      { type: "image", mediaType: "image/png", data: "BASE64DATA", path: "/tmp/x.png" },
    ];
    const out = convertUserParts(parts);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) {
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ type: "text", text: "what is this" });
      expect(out[1]).toEqual({ type: "image", image: "BASE64DATA", mimeType: "image/png" });
    }
  });

  it("file without mimeType → omits mimeType attr in wrap", () => {
    const out = convertUserParts([
      { type: "file", path: "/p.txt", text: "x" },
    ]);
    expect(typeof out).toBe("string");
    if (typeof out === "string") {
      expect(out).toContain(`<file path="/p.txt">`);
      expect(out).not.toContain("mimeType=");
    }
  });

  it("empty parts → empty string", () => {
    expect(convertUserParts([])).toBe("");
  });

  it("mixed file + image — file downgrades inline, image stays as part", () => {
    const out = convertUserParts([
      { type: "text", text: "review" },
      { type: "file", path: "/a.ts", text: "a" },
      { type: "image", mediaType: "image/jpeg", data: "IMG" },
    ]);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) {
      expect(out).toHaveLength(3);
      expect(out[0]).toEqual({ type: "text", text: "review" });
      expect(out[1].type).toBe("text"); // file downgraded
      expect((out[1] as { type: "text"; text: string }).text).toContain(`<file path="/a.ts">`);
      expect(out[2]).toEqual({ type: "image", image: "IMG", mimeType: "image/jpeg" });
    }
  });
});
