/**
 * Skills inject 测试 — 短列表 + 激活 body 两段渲染。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.6。
 */

import { describe, it, expect } from "vitest";
import { renderAvailableSkillsSection, renderActivatedSkillBody } from "../src/skills/inject.js";
import type { SkillFile } from "../src/skills/types.js";

function mkSkill(opts: Partial<SkillFile> & { name: string; description?: string }): SkillFile {
  return {
    name: opts.name,
    frontmatter: {
      name: opts.name,
      description: opts.description ?? `${opts.name} description here`,
      "allowed-tools": opts.frontmatter?.["allowed-tools"],
      "disable-model-invocation": opts.frontmatter?.["disable-model-invocation"],
    },
    body: opts.body ?? `body of ${opts.name}`,
    filePath: opts.filePath ?? `/fake/${opts.name}/SKILL.md`,
    dirPath: opts.dirPath ?? `/fake/${opts.name}`,
    scope: opts.scope ?? "personal",
  };
}

describe("renderAvailableSkillsSection", () => {
  it("0 skills → 空字符串", () => {
    expect(renderAvailableSkillsSection([])).toBe("");
  });

  it("仅 disable-model-invocation=true → 空字符串(LLM 看不到)", () => {
    const skills = [
      mkSkill({
        name: "hidden",
        frontmatter: { name: "hidden", description: "x", "disable-model-invocation": true },
      } as Partial<SkillFile> & { name: string }),
    ];
    expect(renderAvailableSkillsSection(skills)).toBe("");
  });

  it("含 1 个可见 skill → 短列表 + 头部说明", () => {
    const out = renderAvailableSkillsSection([mkSkill({ name: "deploy", description: "deploy prod desc here" })]);
    expect(out).toContain("# Available skills");
    expect(out).toContain("- **deploy** [personal] — deploy prod desc here");
    expect(out).toContain("/skill list");
  });

  it("含 allowed-tools 时一行显示", () => {
    const s = mkSkill({
      name: "deploy",
      description: "deploy prod desc here",
      frontmatter: { name: "deploy", description: "deploy prod desc here", "allowed-tools": ["Bash", "Read"] },
    } as Partial<SkillFile> & { name: string });
    const out = renderAvailableSkillsSection([s]);
    expect(out).toContain("(allowed: Bash, Read)");
  });

  it("混合可见 + hidden,仅可见的在列表", () => {
    const skills = [
      mkSkill({ name: "visible", description: "visible desc here" }),
      mkSkill({
        name: "hidden",
        frontmatter: { name: "hidden", description: "x", "disable-model-invocation": true },
      } as Partial<SkillFile> & { name: string }),
    ];
    const out = renderAvailableSkillsSection(skills);
    expect(out).toContain("visible");
    expect(out).not.toContain("hidden");
  });
});

describe("renderActivatedSkillBody", () => {
  it("0 skill → 空字符串", () => {
    expect(renderActivatedSkillBody([])).toBe("");
  });

  it("1 skill → 标题 + body", () => {
    const out = renderActivatedSkillBody([mkSkill({ name: "deploy", body: "step 1\nstep 2" })]);
    expect(out).toContain("# Skill activated: deploy");
    expect(out).toContain("step 1");
    expect(out).toContain("step 2");
  });

  it("多 skill → 按顺序拼接", () => {
    const out = renderActivatedSkillBody([
      mkSkill({ name: "a", body: "body-a" }),
      mkSkill({ name: "b", body: "body-b" }),
    ]);
    const idxA = out.indexOf("Skill activated: a");
    const idxB = out.indexOf("Skill activated: b");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });
});
