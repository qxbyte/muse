import { describe, it, expect } from "vitest";
import { InputPipeline, createInputCtx } from "../../src/preprocess/input/index.js";

describe("expand-image-placeholder stage", () => {
  it("pushes ImagePart from registry + keeps placeholder in text (path stores [Image #N])", async () => {
    const registry = new Map<number, { data: Buffer; mediaType: "image/png" }>([
      [1, { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" }],
    ]);
    const ctx = createInputCtx({
      raw: "请看 [Image #1] 这张图",
      source: "tty",
      cwd: "/tmp",
      mode: "default",
      capabilities: { supportsImages: true },
    });
    await InputPipeline({ imageRegistry: registry }).run(ctx);

    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments[0].type).toBe("image");
    if (ctx.attachments[0].type === "image") {
      expect(ctx.attachments[0].mediaType).toBe("image/png");
      expect(ctx.attachments[0].data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
      expect(ctx.attachments[0].path).toBe("[Image #1]");
    }
    // 占位符现在保留(B-10 起):UI 渲染要用,LLM 也借此理解 explicit 引用位置
    expect(ctx.text).toContain("[Image #1]");
    expect(ctx.text).toContain("请看");
    expect(ctx.text).toContain("这张图");
  });

  it("handles multiple [Image #N] placeholders in one input (all kept in text)", async () => {
    const registry = new Map<number, { data: Buffer; mediaType: "image/png" }>([
      [1, { data: Buffer.from([0xaa]), mediaType: "image/png" }],
      [2, { data: Buffer.from([0xbb]), mediaType: "image/png" }],
    ]);
    const ctx = createInputCtx({
      raw: "对比 [Image #1] 和 [Image #2]",
      source: "tty",
      cwd: "/tmp",
      mode: "default",
      capabilities: { supportsImages: true },
    });
    await InputPipeline({ imageRegistry: registry }).run(ctx);
    expect(ctx.attachments).toHaveLength(2);
    // 占位符保留,顺序也保留
    expect(ctx.text).toContain("[Image #1]");
    expect(ctx.text).toContain("[Image #2]");
  });

  it("warning + skip when registry entry missing (placeholder replaced with explanation)", async () => {
    const registry = new Map<number, { data: Buffer; mediaType: "image/png" }>();
    const ctx = createInputCtx({
      raw: "[Image #99]",
      source: "tty",
      cwd: "/tmp",
      mode: "default",
      capabilities: { supportsImages: true },
    });
    await InputPipeline({ imageRegistry: registry }).run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.warnings.find((w) => w.message.includes("not found in registry"))).toBeDefined();
    // 原 [Image #99] 占位符替换为说明文本,LLM 仍能看到上下文
    expect(ctx.text).not.toContain("[Image #99]");
    expect(ctx.text).toContain("[image attachment unavailable]");
  });

  it("capability gate: supportsImages=false → keep placeholder as explanation text (LLM still sees intent)", async () => {
    const registry = new Map<number, { data: Buffer; mediaType: "image/png" }>([
      [1, { data: Buffer.from([0xaa]), mediaType: "image/png" }],
    ]);
    const ctx = createInputCtx({
      raw: "看看 [Image #1]",
      source: "tty",
      cwd: "/tmp",
      mode: "default",
      capabilities: { supportsImages: false },
    });
    await InputPipeline({ imageRegistry: registry }).run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.warnings.find((w) => w.message.includes("does not support images"))).toBeDefined();
    // 占位符不是简单移除 — 替换为"用户想发图但模型不支持"的提示,避免空消息让 LLM 自由发挥
    expect(ctx.text).not.toContain("[Image #1]");
    expect(ctx.text).toContain("看看");
    expect(ctx.text).toContain("does not support vision");
    expect(ctx.text).toContain("mimo-v2.5");
  });

  it("noop when no registry provided", async () => {
    const ctx = createInputCtx({
      raw: "no placeholder here",
      source: "tty",
      cwd: "/tmp",
      mode: "default",
      capabilities: { supportsImages: true },
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.text).toBe("no placeholder here");
  });
});
