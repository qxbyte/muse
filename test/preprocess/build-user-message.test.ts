import { describe, it, expect } from "vitest";
import { buildUserMessage, createInputCtx } from "../../src/preprocess/input/index.js";

describe("buildUserMessage", () => {
  it("returns string when no attachments (backward compat)", () => {
    const ctx = createInputCtx({ raw: "hello", source: "tty", cwd: "/tmp", mode: "default" });
    ctx.text = "hello";
    const out = buildUserMessage(ctx);
    expect(out).toBe("hello");
  });

  it("returns ContentPart[] when file attachments present", () => {
    const ctx = createInputCtx({ raw: "look @./a.ts", source: "tty", cwd: "/tmp", mode: "default" });
    ctx.text = "look @./a.ts";
    ctx.attachments.push({ type: "file", path: "/tmp/a.ts", mimeType: "text/x-typescript", text: "const x = 1" });
    const out = buildUserMessage(ctx);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) {
      expect(out[0]).toEqual({ type: "text", text: "look @./a.ts" });
      expect(out[1]).toEqual({ type: "file", path: "/tmp/a.ts", mimeType: "text/x-typescript", text: "const x = 1" });
    }
  });

  it("preserves multiple attachments in push order", () => {
    const ctx = createInputCtx({ raw: "x", source: "tty", cwd: "/tmp", mode: "default" });
    ctx.text = "x";
    ctx.attachments.push({ type: "file", path: "/tmp/a.ts", text: "a" });
    ctx.attachments.push({ type: "file", path: "/tmp/b.ts", text: "b" });
    ctx.attachments.push({ type: "image", mediaType: "image/png", data: "base64data", path: "/tmp/c.png" });
    const out = buildUserMessage(ctx);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) {
      expect(out).toHaveLength(4); // text + 2 files + 1 image
      expect(out[1].type).toBe("file");
      expect(out[2].type).toBe("file");
      expect(out[3].type).toBe("image");
    }
  });
});
