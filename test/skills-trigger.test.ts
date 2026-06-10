/**
 * Skills 触发监听单测。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7.1。
 */

import { describe, it, expect } from "vitest";
import { detectSkillTriggers } from "../src/skills/trigger.js";
import type { SkillFile, SkillRegistry } from "../src/skills/types.js";

function mkSkill(name: string, hidden = false): SkillFile {
  return {
    name,
    frontmatter: {
      name,
      description: `${name} description goes here for zod validation`,
      "disable-model-invocation": hidden,
    },
    body: `body of ${name}`,
    filePath: `/fake/${name}/SKILL.md`,
    dirPath: `/fake/${name}`,
    scope: "personal",
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

describe("detectSkillTriggers", () => {
  it("text 含 skill name(整词)→ 触发", () => {
    const reg = mkRegistry([mkSkill("deploy"), mkSkill("migrate")]);
    const hits = detectSkillTriggers("I'll use deploy to ship this", reg, new Set());
    expect(hits.map((s) => s.name)).toEqual(["deploy"]);
  });

  it("text 不含任何 skill → 空", () => {
    const reg = mkRegistry([mkSkill("deploy")]);
    expect(detectSkillTriggers("just answering a question", reg, new Set())).toEqual([]);
  });

  it("case-insensitive 匹配", () => {
    const reg = mkRegistry([mkSkill("deploy")]);
    const hits = detectSkillTriggers("Let's DEPLOY now", reg, new Set());
    expect(hits.map((s) => s.name)).toEqual(["deploy"]);
  });

  it("已激活的 skill 跳过(去重)", () => {
    const reg = mkRegistry([mkSkill("deploy"), mkSkill("migrate")]);
    const hits = detectSkillTriggers("deploy and migrate", reg, new Set(["deploy"]));
    expect(hits.map((s) => s.name)).toEqual(["migrate"]);
  });

  it("disable-model-invocation=true 的 skill 不触发", () => {
    const reg = mkRegistry([mkSkill("hidden", true)]);
    expect(detectSkillTriggers("hidden hidden hidden", reg, new Set())).toEqual([]);
  });

  it("整词边界:'deploy' 不匹配 'redeploy'", () => {
    const reg = mkRegistry([mkSkill("deploy")]);
    expect(detectSkillTriggers("redeploy logic", reg, new Set())).toEqual([]);
  });

  it("带连字符的 skill 名(deploy-prod)正常匹配", () => {
    const reg = mkRegistry([mkSkill("deploy-prod")]);
    const hits = detectSkillTriggers("Running deploy-prod now", reg, new Set());
    expect(hits.map((s) => s.name)).toEqual(["deploy-prod"]);
  });

  it("空 text → 空", () => {
    const reg = mkRegistry([mkSkill("deploy")]);
    expect(detectSkillTriggers("", reg, new Set())).toEqual([]);
  });

  it("多个不同 skill 同时命中", () => {
    const reg = mkRegistry([mkSkill("deploy"), mkSkill("migrate"), mkSkill("test-suite")]);
    const hits = detectSkillTriggers("First deploy, then migrate the DB", reg, new Set());
    expect(hits.map((s) => s.name).sort()).toEqual(["deploy", "migrate"]);
  });
});
