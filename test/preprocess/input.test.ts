import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputPipeline, createInputCtx } from "../../src/preprocess/input/index.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "muse-input-"));
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

describe("InputPipeline", () => {
  it("short-circuits on slash command", async () => {
    const ctx = createInputCtx({
      raw: "/help arg1 arg2",
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.slashCommand?.name).toBe("help");
    expect(ctx.slashCommand?.args).toBe("arg1 arg2");
  });

  it("expands paste placeholders", async () => {
    const registry = new Map<number, string>([[1, "PASTED_CONTENT"]]);
    const ctx = createInputCtx({
      raw: "before [Pasted text #1 +3 lines] after",
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline({ pasteRegistry: registry }).run(ctx);
    expect(ctx.text).toContain("PASTED_CONTENT");
    expect(ctx.text).not.toContain("Pasted text #1");
  });

  it("expands @file references as FilePart attachments (not XML-wrapped text)", async () => {
    const file = join(workdir, "ref.txt");
    writeFileSync(file, "HELLO FROM FILE", "utf-8");
    const ctx = createInputCtx({
      raw: `please review @${file}`,
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(1);
    const att = ctx.attachments[0];
    expect(att.type).toBe("file");
    if (att.type === "file") {
      expect(att.path).toBe(file);
      expect(att.text).toBe("HELLO FROM FILE");
      expect(att.mimeType).toBe("text/plain");
    }
    // text 不再 wrap XML;@<path> 引用本身保留
    expect(ctx.text).not.toContain("<file");
    expect(ctx.text).not.toContain("HELLO FROM FILE");
    expect(ctx.text).toContain(`@${file}`);
  });

  it("at-image picks up @image.png when capabilities.supportsImages=true", async () => {
    const png = join(workdir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    writeFileSync(png, bytes);
    const ctx = createInputCtx({
      raw: `look @${png}`,
      source: "tty",
      cwd: workdir,
      mode: "default",
      capabilities: { supportsImages: true },
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(1);
    const att = ctx.attachments[0];
    expect(att.type).toBe("image");
    if (att.type === "image") {
      expect(att.mediaType).toBe("image/png");
      expect(att.path).toBe(png);
      expect(att.data).toBe(bytes.toString("base64"));
    }
  });

  it("at-image skipped with warning when capabilities.supportsImages=false", async () => {
    const png = join(workdir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ctx = createInputCtx({
      raw: `look @${png}`,
      source: "tty",
      cwd: workdir,
      mode: "default",
      capabilities: { supportsImages: false },
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.warnings.find((w) => w.stage === "at-image")).toBeDefined();
  });

  it("at-image refuses oversized image", async () => {
    const png = join(workdir, "huge.png");
    writeFileSync(png, Buffer.alloc(200, 0xff));
    const ctx = createInputCtx({
      raw: `@${png}`,
      source: "tty",
      cwd: workdir,
      mode: "default",
      capabilities: { supportsImages: true },
      settings: { atImage: { maxBytes: 100 } },
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.warnings.find((w) => w.message.includes("too large"))).toBeDefined();
  });

  it("at-file-expand still skips image extensions (delegated to at-image)", async () => {
    const png = join(workdir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 不传 capabilities,supportsImages 默认 false → 两个 stage 都不收
    const ctx = createInputCtx({
      raw: `@${png}`,
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(0);
  });

  it("redacts secrets in input", async () => {
    const ctx = createInputCtx({
      raw: "key=sk-" + "a".repeat(48),
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.text).toContain("[REDACTED:openai-key]");
    expect(ctx.warnings.length).toBeGreaterThan(0);
  });

  it("truncates input over maxChars", async () => {
    const huge = "x".repeat(100000);
    const ctx = createInputCtx({
      raw: huge,
      source: "tty",
      cwd: workdir,
      mode: "default",
      settings: { maxChars: 1000 },
    });
    await InputPipeline().run(ctx);
    expect(ctx.text.length).toBeLessThanOrEqual(1100);
    expect(ctx.warnings.find((w) => w.stage === "validate-length")).toBeDefined();
  });

  it("expands {{cwd}} template", async () => {
    const ctx = createInputCtx({
      raw: "working in {{cwd}}",
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.text).toContain(workdir);
  });

  it("refuses {{env:DEEPSEEK_API_KEY}}", async () => {
    process.env.DEEPSEEK_API_KEY = "secret-test-key";
    const ctx = createInputCtx({
      raw: "key={{env:DEEPSEEK_API_KEY}}",
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.text).toContain("{{env:DEEPSEEK_API_KEY}}");
    expect(ctx.text).not.toContain("secret-test-key");
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("blocks @ reference to ~/.ssh/", async () => {
    const ctx = createInputCtx({
      raw: "@~/.ssh/id_rsa please",
      source: "tty",
      cwd: workdir,
      mode: "default",
    });
    await InputPipeline().run(ctx);
    expect(ctx.attachments).toHaveLength(0);
    expect(ctx.warnings.find((w) => w.message.includes(".ssh"))).toBeDefined();
  });
});

