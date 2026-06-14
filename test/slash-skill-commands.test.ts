/**
 * skillsToSlashCommands 测试(扩展接入口 §五.7 — skill 作为 slash 命令)。
 *
 * 验证:每个 skill → /<name>;撞内置名加 skill: 前缀;execute 走 activateSkill。
 */

import { describe, it, expect } from "vitest";
import { skillsToSlashCommands } from "../src/slash/skill-commands.js";
import type { SkillFile } from "../src/skills/types.js";
import type { SlashCommandContext } from "../src/slash/types.js";

function mkSkill(name: string, opts: Partial<SkillFile["frontmatter"]> & { scope?: SkillFile["scope"] } = {}): SkillFile {
  return {
    name,
    frontmatter: {
      name,
      description: opts.description ?? `${name} description goes here for zod`,
      "disable-model-invocation": opts["disable-model-invocation"],
    },
    body: `body of ${name}`,
    filePath: `/fake/${name}/SKILL.md`,
    dirPath: `/fake/${name}`,
    scope: opts.scope ?? "personal",
    mounted: (opts as { mounted?: boolean }).mounted,
  };
}

/** 收集 activateSkill 调用的 ctx。 */
function mkCtx(activateResult: string | null, calls: string[]): SlashCommandContext {
  return {
    actions: {
      activateSkill: async (name: string) => {
        calls.push(name);
        return activateResult;
      },
    },
  } as unknown as SlashCommandContext;
}

describe("skillsToSlashCommands", () => {
  it("每个 skill → 一条 /<name> 命令", () => {
    const cmds = skillsToSlashCommands([mkSkill("deploy"), mkSkill("migrate")], () => false);
    expect(cmds.map((c) => c.name)).toEqual(["deploy", "migrate"]);
  });

  it("撞内置名 → 加 skill: 前缀", () => {
    const builtins = new Set(["clear", "model", "skill"]);
    const cmds = skillsToSlashCommands([mkSkill("model"), mkSkill("deploy")], (n) => builtins.has(n));
    expect(cmds.find((c) => c.name === "skill:model")).toBeDefined();
    expect(cmds.find((c) => c.name === "deploy")).toBeDefined();
    // 不应直接占用内置名 model
    expect(cmds.find((c) => c.name === "model")).toBeUndefined();
  });

  it("加前缀后仍冲突 → 跳过该条", () => {
    // 既占了 dep 也占了 skill:dep
    const taken = new Set(["dep", "skill:dep"]);
    const cmds = skillsToSlashCommands([mkSkill("dep")], (n) => taken.has(n));
    expect(cmds).toHaveLength(0);
  });

  it("execute 用原始 skill 名调 activateSkill(即使命令名带前缀)", async () => {
    const calls: string[] = [];
    const cmds = skillsToSlashCommands([mkSkill("model")], (n) => n === "model");
    const cmd = cmds[0];
    expect(cmd.name).toBe("skill:model");
    const res = await cmd.execute(mkCtx(null, calls));
    expect(calls).toEqual(["model"]); // 原始 skill 名,不是 skill:model
    expect((res as { display: string }).display).toContain("activated");
  });

  it("activateSkill 返回错误 → 透传 reason", async () => {
    const calls: string[] = [];
    const cmds = skillsToSlashCommands([mkSkill("deploy")], () => false);
    const res = await cmds[0].execute(mkCtx("already active this turn", calls));
    expect((res as { display: string }).display).toContain("Failed to activate");
    expect((res as { display: string }).display).toContain("already active");
  });

  it("description 截断 + scope 标记", () => {
    const long = "x".repeat(200);
    const cmds = skillsToSlashCommands([mkSkill("d", { description: long, scope: "project" })], () => false);
    expect(cmds[0].description).toContain("[skill:project]");
    expect(cmds[0].description.length).toBeLessThan(90); // 截断生效
  });

  it("hidden / 未挂载 skill 仍生成命令(显式触发不受可见性约束)", () => {
    const skills = [
      mkSkill("hidden", { "disable-model-invocation": true }),
      mkSkill("unmounted", { mounted: false } as never),
    ];
    const cmds = skillsToSlashCommands(skills, () => false);
    expect(cmds.map((c) => c.name).sort()).toEqual(["hidden", "unmounted"]);
  });
});
