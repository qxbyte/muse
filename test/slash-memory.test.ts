/**
 * II-3 /memory slash 测试。
 *
 * 通过 BUILTIN_SLASH_COMMANDS 找到 /memory 命令,用 minimal SlashCommandContext mock 跑 execute。
 * 隔离:每个 test 用 mkdtemp HOME(memory 文件落 ~/.muse/projects/<hash>/memory/)。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SLASH_COMMANDS } from "../src/slash/builtin.js";
import type { SlashCommand, SlashCommandContext } from "../src/slash/types.js";
import { writeMemory } from "../src/loop/memory.js";

const FIXED_CWD = "/Users/test/slash-mem-proj";
let testHome: string;
let originalHome: string | undefined;

const memoryCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "memory") as SlashCommand;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-slashmem-"));
  process.env.HOME = testHome;
});

afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
});

function mkCtx(args: string): SlashCommandContext {
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
  };
}

describe("II-3 /memory slash", () => {
  it("命令已注册", () => {
    expect(memoryCmd).toBeDefined();
    expect(memoryCmd.name).toBe("memory");
  });

  it("/memory(无参)= list 空场景显示帮助 + 0 条", async () => {
    const result = await memoryCmd.execute(mkCtx(""));
    expect(result.display).toContain("(no memories saved for this project)");
    expect(result.display).toContain("Usage:");
  });

  it("/memory list 含 3 条 — 按 trust → updated_at 排序", async () => {
    await writeMemory(FIXED_CWD, { name: "a-auto", description: "first", type: "user", body: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, {
      name: "b-verified",
      description: "second",
      type: "feedback",
      body: "y",
      trust: "verified",
    });
    await new Promise((r) => setTimeout(r, 10));
    await writeMemory(FIXED_CWD, { name: "c-auto", description: "third", type: "project", body: "z" });

    const result = await memoryCmd.execute(mkCtx("list"));
    const text = result.display!;
    expect(text).toContain("Memories for this project (3)");
    // b-verified 应出现在 c-auto 和 a-auto 之前
    const idxB = text.indexOf("b-verified");
    const idxC = text.indexOf("c-auto");
    const idxA = text.indexOf("a-auto");
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
    // trust + type 标签都在
    expect(text).toContain("[verified]");
    expect(text).toContain("[auto]");
    expect(text).toContain("(feedback)");
    expect(text).toContain("(project)");
  });

  it("/memory view <name> 显示完整 frontmatter + body", async () => {
    await writeMemory(FIXED_CWD, {
      name: "v1",
      description: "view test",
      type: "user",
      body: "the body content",
    });
    const result = await memoryCmd.execute(mkCtx("view v1"));
    const text = result.display!;
    expect(text).toContain("v1");
    expect(text).toContain("trust:");
    expect(text).toContain("auto");
    expect(text).toContain("source:");
    expect(text).toContain("manual-write");
    expect(text).toContain("--- Body ---");
    expect(text).toContain("the body content");
  });

  it("/memory view 不存在 → 错误提示", async () => {
    const result = await memoryCmd.execute(mkCtx("view nonexistent"));
    expect(result.display).toMatch(/Memory operation failed/);
    expect(result.display).toMatch(/does not exist/);
  });

  it("/memory delete <name> 删除", async () => {
    await writeMemory(FIXED_CWD, { name: "d1", description: "to delete", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("delete d1"));
    expect(result.display).toContain(`Deleted memory "d1"`);
    // 再查 list 应该是 0
    const listResult = await memoryCmd.execute(mkCtx("list"));
    expect(listResult.display).toContain("(no memories saved");
  });

  it("/memory promote auto → verified", async () => {
    await writeMemory(FIXED_CWD, { name: "p1", description: "promote test", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("promote p1"));
    expect(result.display).toContain("auto → verified");
    // 再 view 验证 trust 已升
    const viewResult = await memoryCmd.execute(mkCtx("view p1"));
    expect(viewResult.display).toMatch(/trust:\s+verified/);
  });

  it("/memory promote verified → 提示已是 verified", async () => {
    await writeMemory(FIXED_CWD, {
      name: "p2",
      description: "already verified",
      type: "user",
      body: "x",
      trust: "verified",
    });
    const result = await memoryCmd.execute(mkCtx("promote p2"));
    expect(result.display).toContain("already verified");
  });

  it("/memory trust <name> verified 显式升级", async () => {
    await writeMemory(FIXED_CWD, { name: "t1", description: "trust test", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("trust t1 verified"));
    expect(result.display).toContain(`Set "t1" trust → verified`);
  });

  it("/memory trust <name> trusted → 拒绝(hierarchy 专属)", async () => {
    await writeMemory(FIXED_CWD, { name: "t2", description: "trusted attempt", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("trust t2 trusted"));
    expect(result.display).toMatch(/Cannot set trust=trusted/);
    expect(result.display).toMatch(/MUSE\.md.*AGENTS\.md/);
  });

  it("/memory trust <name> invalid → 提示 valid levels", async () => {
    await writeMemory(FIXED_CWD, { name: "t3", description: "invalid", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("trust t3 high"));
    expect(result.display).toContain("Invalid trust level");
    expect(result.display).toContain("trusted");
    expect(result.display).toContain("verified");
    expect(result.display).toContain("auto");
  });

  it("/memory trust 降级被拒(setMemoryTrust 内部约束)", async () => {
    await writeMemory(FIXED_CWD, {
      name: "t4",
      description: "降级测试",
      type: "user",
      body: "x",
      trust: "verified",
    });
    const result = await memoryCmd.execute(mkCtx("trust t4 auto"));
    expect(result.display).toMatch(/Cannot lower trust/);
  });

  it("/memory unknown 显示帮助", async () => {
    const result = await memoryCmd.execute(mkCtx("unknown-sub-command"));
    expect(result.display).toContain("Unknown subcommand");
    expect(result.display).toContain("Usage:");
  });

  it("/memory help 显示帮助", async () => {
    const result = await memoryCmd.execute(mkCtx("help"));
    expect(result.display).toContain("Usage:");
    expect(result.display).toContain("/memory view");
    expect(result.display).toContain("/memory promote");
  });

  it("/memory rm 是 delete 别名", async () => {
    await writeMemory(FIXED_CWD, { name: "rm-test", description: "rm alias", type: "user", body: "x" });
    const result = await memoryCmd.execute(mkCtx("rm rm-test"));
    expect(result.display).toContain(`Deleted memory "rm-test"`);
  });
});
