/**
 * /skill slash 命令测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7.2。
 */

import { describe, it, expect } from "vitest";
import { SKILL } from "../src/slash/skill.js";
import type { SlashCommandContext } from "../src/slash/types.js";
import type { SkillFile, SkillRegistry } from "../src/skills/types.js";

function mkSkill(name: string, opts: { hidden?: boolean; scope?: "personal" | "project"; allowed?: string[] } = {}): SkillFile {
  return {
    name,
    frontmatter: {
      name,
      description: `${name} description goes here for zod validation`,
      "allowed-tools": opts.allowed,
      "disable-model-invocation": opts.hidden,
    },
    body: `# Body of ${name}\nstep 1\nstep 2`,
    filePath: `/fake/${name}/SKILL.md`,
    dirPath: `/fake/${name}`,
    scope: opts.scope ?? "personal",
  };
}

function mkRegistry(files: SkillFile[]): SkillRegistry {
  const byName = new Map(files.map((f) => [f.name, f]));
  return {
    list: () => files,
    get: (n) => byName.get(n),
    listInvocable: () => files.filter((f) => !f.frontmatter["disable-model-invocation"]),
    size: () => files.length,
  };
}

function mkCtx(args: string, registry?: SkillRegistry, activateResult: string | null = null): SlashCommandContext {
  return {
    args,
    cwd: "/fake",
    llm: {} as never,
    session: {} as never,
    settings: {},
    settingsSources: [],
    skillRegistry: registry,
    history: [],
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    listCommands: () => [],
    actions: {
      activateSkill: (_n: string) => activateResult,
    } as never,
  };
}

describe("/skill list", () => {
  it("registry undefined → 提示 not enabled", () => {
    const result = SKILL.execute(mkCtx(""));
    expect((result as { display: string }).display).toMatch(/Skills not enabled/);
  });

  it("空 registry → 给配置提示", () => {
    const result = SKILL.execute(mkCtx("", mkRegistry([])));
    expect((result as { display: string }).display).toMatch(/No skills found/);
  });

  it("默认无参 = list", () => {
    const result = SKILL.execute(mkCtx("", mkRegistry([mkSkill("deploy")])));
    expect((result as { display: string }).display).toContain("deploy");
    expect((result as { display: string }).display).toContain("Skills (1 total)");
  });

  it("显式 list", () => {
    const result = SKILL.execute(mkCtx("list", mkRegistry([mkSkill("deploy"), mkSkill("migrate")])));
    expect((result as { display: string }).display).toContain("deploy");
    expect((result as { display: string }).display).toContain("migrate");
  });

  it("project scope 排在 personal 之前", () => {
    const skills = [
      mkSkill("from-personal", { scope: "personal" }),
      mkSkill("from-project", { scope: "project" }),
    ];
    const result = SKILL.execute(mkCtx("list", mkRegistry(skills)));
    const text = (result as { display: string }).display;
    const idxProj = text.indexOf("from-project");
    const idxPers = text.indexOf("from-personal");
    expect(idxProj).toBeLessThan(idxPers);
  });

  it("hidden(disable-model-invocation=true)标 [hidden]", () => {
    const result = SKILL.execute(mkCtx("list", mkRegistry([mkSkill("secret", { hidden: true })])));
    expect((result as { display: string }).display).toContain("[hidden]");
  });
});

describe("/skill info", () => {
  it("缺 name → usage", () => {
    const result = SKILL.execute(mkCtx("info", mkRegistry([mkSkill("deploy")])));
    expect((result as { display: string }).display).toMatch(/Usage/);
  });

  it("name 不存在 → 提示", () => {
    const result = SKILL.execute(mkCtx("info nonexistent", mkRegistry([mkSkill("deploy")])));
    expect((result as { display: string }).display).toMatch(/not found/);
  });

  it("显示 frontmatter + body", () => {
    const result = SKILL.execute(mkCtx("info deploy", mkRegistry([mkSkill("deploy", { allowed: ["Bash"] })])));
    const text = (result as { display: string }).display;
    expect(text).toContain("# deploy");
    expect(text).toContain("Bash");
    expect(text).toContain("Body of deploy");
  });
});

describe("/skill run", () => {
  it("缺 name → usage", () => {
    const result = SKILL.execute(mkCtx("run", mkRegistry([mkSkill("deploy")])));
    expect((result as { display: string }).display).toMatch(/Usage/);
  });

  it("成功 → 提示已激活", () => {
    const result = SKILL.execute(mkCtx("run deploy", mkRegistry([mkSkill("deploy")]), null));
    expect((result as { display: string }).display).toContain("activated");
  });

  it("失败 → 透传 reason", () => {
    const result = SKILL.execute(mkCtx("run deploy", mkRegistry([mkSkill("deploy")]), "skill \"deploy\" not found"));
    expect((result as { display: string }).display).toContain("Failed to activate");
    expect((result as { display: string }).display).toContain("not found");
  });
});

describe("/skill 未知子命令", () => {
  it("回 usage", () => {
    const result = SKILL.execute(mkCtx("garbage", mkRegistry([])));
    expect((result as { display: string }).display).toMatch(/Usage/);
  });
});
