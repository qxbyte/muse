/**
 * at-skill-expand stage 测试(扩展接入口 §十 @skill mention)。
 *
 * 验证:@<skill> → 记录到 ctx.skillActivations + 剥掉 @;
 *       非 skill 的 @ 不动(留给 at-file-expand);未注入 skillNames → skip。
 */

import { describe, it, expect } from "vitest";
import { AtSkillExpandStage } from "../../src/preprocess/input/at-skill-expand.js";
import { createInputCtx, type InputCtx } from "../../src/preprocess/input/ctx.js";

function mkCtx(text: string, skillNames?: string[]): InputCtx {
  const ctx = createInputCtx({ raw: text, source: "tty", cwd: "/x", mode: "default", skillNames });
  ctx.text = text;
  return ctx;
}

const stage = new AtSkillExpandStage();

describe("AtSkillExpandStage", () => {
  it("无 skillNames → skip", () => {
    expect(stage.skip(mkCtx("@deploy-prod"))).toBe(true);
    expect(stage.skip(mkCtx("@deploy-prod", []))).toBe(true);
    expect(stage.skip(mkCtx("@deploy-prod", ["deploy-prod"]))).toBe(false);
  });

  it("命中 skill → 记录激活 + 剥掉 @", () => {
    const ctx = mkCtx("please run @deploy-prod now", ["deploy-prod"]);
    stage.run(ctx);
    expect(ctx.skillActivations).toEqual(["deploy-prod"]);
    expect(ctx.text).toBe("please run deploy-prod now");
  });

  it("非 skill 的 @ 保留(留给 at-file-expand)", () => {
    const ctx = mkCtx("see @src/index.ts and @deploy", ["deploy"]);
    stage.run(ctx);
    expect(ctx.skillActivations).toEqual(["deploy"]);
    // @src/index.ts(含 /)不被 skill 正则匹配 → 原样保留
    expect(ctx.text).toContain("@src/index.ts");
    // @deploy 命中 skill → 剥 @
    expect(ctx.text).toContain("see @src/index.ts and deploy");
  });

  it("同一 skill 多次出现 → 全部剥 @,激活去重", () => {
    const ctx = mkCtx("@build then @build again", ["build"]);
    stage.run(ctx);
    expect(ctx.skillActivations).toEqual(["build"]);
    expect(ctx.text).toBe("build then build again");
  });

  it("多个不同 skill 全部记录", () => {
    const ctx = mkCtx("@deploy and @migrate", ["deploy", "migrate"]);
    stage.run(ctx);
    expect(ctx.skillActivations.sort()).toEqual(["deploy", "migrate"]);
    expect(ctx.text).toBe("deploy and migrate");
  });

  it("行首的 @skill 也命中", () => {
    const ctx = mkCtx("@deploy go", ["deploy"]);
    stage.run(ctx);
    expect(ctx.skillActivations).toEqual(["deploy"]);
    expect(ctx.text).toBe("deploy go");
  });

  it("未加载的 skill 名不动", () => {
    const ctx = mkCtx("@unknown-skill", ["deploy"]);
    stage.run(ctx);
    expect(ctx.skillActivations).toEqual([]);
    expect(ctx.text).toBe("@unknown-skill");
  });
});
