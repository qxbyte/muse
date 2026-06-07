/**
 * /memory diff + /memory edit + local-transformers preset 路由测试。
 *
 * - diff:按 updated_at 降序 + 时间标签
 * - edit:openInEditor mock → 文件改了升 trust / 没改不动 / 文件被删提示
 * - local-transformers:factory 解析 local-* preset 创建 LocalTransformersEmbeddingProvider
 *   (实际 embed 调用未测,因为依赖 @huggingface/transformers 真包)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SLASH_COMMANDS } from "../src/slash/builtin.js";
import type { SlashCommand, SlashCommandContext, SlashActions } from "../src/slash/types.js";
import { writeMemory, setMemoryTrust } from "../src/loop/memory.js";
import {
  createEmbeddingProvider,
  LocalTransformersEmbeddingProvider,
  getPreset,
} from "../src/loop/embedding/index.js";

const FIXED_CWD = "/Users/test/memdedit-proj";
let testHome: string;
let originalHome: string | undefined;

const memoryCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "memory") as SlashCommand;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-mde-"));
  process.env.HOME = testHome;
});
afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function mkCtx(args: string, overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    args,
    cwd: FIXED_CWD,
    llm: {} as never,
    session: {} as never,
    settings: {},
    settingsSources: [],
    history: [],
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    listCommands: () => [],
    actions: {} as never,
    ...overrides,
  };
}

describe("/memory diff", () => {
  it("空场景显示提示", async () => {
    const result = await memoryCmd.execute(mkCtx("diff"));
    expect(result.display).toContain("(no memories to diff)");
  });

  it("3 条 memory 按 updated_at 降序 + 时间标签", async () => {
    await writeMemory(FIXED_CWD, { name: "oldest", description: "first", type: "user", body: "x" });
    await new Promise((r) => setTimeout(r, 15));
    await writeMemory(FIXED_CWD, { name: "middle", description: "second", type: "user", body: "x" });
    await new Promise((r) => setTimeout(r, 15));
    await writeMemory(FIXED_CWD, { name: "newest", description: "third", type: "user", body: "x" });

    const result = await memoryCmd.execute(mkCtx("diff"));
    const text = result.display!;
    const newestIdx = text.indexOf("newest");
    const middleIdx = text.indexOf("middle");
    const oldestIdx = text.indexOf("oldest");
    expect(newestIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(oldestIdx);
    // 时间标签
    expect(text).toMatch(/(s|m|h|d)\s+ago/);
  });

  it("--scope user 只列全局层", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "proj", type: "user", body: "x" });
    await writeMemory(FIXED_CWD, { name: "u1", description: "user", type: "user", body: "x", scope: "user" });

    const result = await memoryCmd.execute(mkCtx("diff --scope user"));
    expect(result.display).toContain("u1");
    expect(result.display).not.toContain("p1");
  });
});

describe("/memory edit", () => {
  it("无参 → Usage", async () => {
    const result = await memoryCmd.execute(mkCtx("edit"));
    expect(result.display).toContain("Usage:");
  });

  it("文件未变更 → 无 trust 升级", async () => {
    await writeMemory(FIXED_CWD, { name: "noedit", description: "d", type: "user", body: "b" });
    const openSpy = vi.fn(() => Promise.resolve()); // 编辑器啥也没改
    const result = await memoryCmd.execute(
      mkCtx("edit noedit", { actions: { openInEditor: openSpy } as unknown as SlashActions }),
    );
    expect(openSpy).toHaveBeenCalled();
    expect(result.display).toContain("No changes");
  });

  it("编辑器抛错时返回错信息", async () => {
    await writeMemory(FIXED_CWD, { name: "errcase", description: "d", type: "user", body: "b" });
    const openSpy = vi.fn(() => Promise.reject(new Error("editor exit 1")));
    const result = await memoryCmd.execute(
      mkCtx("edit errcase", { actions: { openInEditor: openSpy } as unknown as SlashActions }),
    );
    expect(result.display).toContain("Editor failed");
    expect(result.display).toContain("editor exit 1");
  });

  it("name 不存在 → 抛错(包装成 Memory operation failed)", async () => {
    const openSpy = vi.fn(() => Promise.resolve());
    const result = await memoryCmd.execute(
      mkCtx("edit nonexistent", { actions: { openInEditor: openSpy } as unknown as SlashActions }),
    );
    expect(result.display).toMatch(/Memory operation failed|does not exist/);
    expect(openSpy).not.toHaveBeenCalled(); // 不存在时没机会调 editor
  });
});

describe("local-transformers preset 路由", () => {
  it("preset 'local-bge-zh' 创建 LocalTransformersEmbeddingProvider", () => {
    const p = createEmbeddingProvider({ preset: "local-bge-zh" });
    expect(p).toBeInstanceOf(LocalTransformersEmbeddingProvider);
    expect(p.dim).toBe(512);
    expect(p.id).toContain("local-transformers");
    expect(p.id).toContain("bge-small-zh-v1.5");
  });

  it("preset 'local-bge-en' 创建 LocalTransformersEmbeddingProvider", () => {
    const p = createEmbeddingProvider({ preset: "local-bge-en" });
    expect(p).toBeInstanceOf(LocalTransformersEmbeddingProvider);
    expect(p.dim).toBe(384);
  });

  it("preset 'local-minilm' 创建 LocalTransformersEmbeddingProvider", () => {
    const p = createEmbeddingProvider({ preset: "local-minilm" });
    expect(p).toBeInstanceOf(LocalTransformersEmbeddingProvider);
    expect(p.dim).toBe(384);
    expect(p.id).toContain("MiniLM-L6-v2");
  });

  it("preset 'local-bge-m3' 创建 LocalTransformersEmbeddingProvider", () => {
    const p = createEmbeddingProvider({ preset: "local-bge-m3" });
    expect(p.dim).toBe(1024);
    expect(p.id).toContain("bge-m3");
  });

  it("local preset 不需要 apiKey", () => {
    expect(getPreset("local-bge-zh")!.requiresKey).toBe(false);
    expect(() => createEmbeddingProvider({ preset: "local-bge-zh" })).not.toThrow();
  });

  it("用户 dim 覆盖 local preset 默认", () => {
    const p = createEmbeddingProvider({ preset: "local-bge-zh", dim: 256 });
    expect(p.dim).toBe(256);
  });

  it("provider='local-minilm' 显式调用 + 模型 + dim → 走 LocalTransformers", () => {
    const p = createEmbeddingProvider({
      provider: "local-minilm",
      model: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
    });
    expect(p).toBeInstanceOf(LocalTransformersEmbeddingProvider);
  });
});
