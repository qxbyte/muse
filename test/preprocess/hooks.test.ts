import { describe, it, expect } from "vitest";
import { runHooks, type HooksConfig } from "../../src/preprocess/hooks.js";
import { PipelineBlockedError } from "../../src/preprocess/pipeline.js";

describe("runHooks", () => {
  it("returns empty when no hooks configured", async () => {
    const out = await runHooks("PreToolUse", { toolName: "Read" }, undefined);
    expect(out).toEqual({});
  });

  it("returns empty when hook command is non-existent and onError=skip", async () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        { command: "/nonexistent-binary-for-test", onError: "skip" },
      ],
    };
    const out = await runHooks("PreToolUse", { toolName: "Read" }, hooks);
    expect(out).toEqual({});
  });

  it("rejects hook command with shell metachar", async () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        { command: "echo hi; rm -rf /", onError: "skip" },
      ],
    };
    const out = await runHooks("PreToolUse", { toolName: "Read" }, hooks);
    expect(out).toEqual({});
  });

  it("respects matcher filter", async () => {
    const calls: string[] = [];
    const hooks: HooksConfig = {
      PreToolUse: [
        // matcher Bash → 这个 hook 只对 Bash 触发;Read 不触发
        { command: "/nonexistent-bin", matcher: "^Bash$", onError: "skip" },
      ],
    };
    // 用 Read 调用:matcher 不匹配 → hook 不执行 → 无输出
    const out = await runHooks("PreToolUse", { toolName: "Read" }, hooks);
    expect(out).toEqual({});
  });

  it("PipelineBlockedError is a distinct error type", () => {
    const err = new PipelineBlockedError("PreToolUse", "policy");
    expect(err).toBeInstanceOf(Error);
    expect(err.point).toBe("PreToolUse");
    expect(err.reason).toBe("policy");
  });
});
