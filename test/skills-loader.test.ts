/**
 * Skills loader 测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.3 / §五.5。
 *
 * 隔离:mkdtemp 临时目录作为 personalDir / projectDir,避免污染真 ~/.muse。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "../src/skills/loader.js";

let personalDir: string;
let projectDir: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "muse-skills-"));
  personalDir = join(base, "personal");
  projectDir = join(base, "project");
  await mkdir(personalDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(personalDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function writeSkill(scopeDir: string, name: string, content: string): Promise<void> {
  const dir = join(scopeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
}

function skillContent(name: string, description = "ten or more chars description"): string {
  return `---
name: ${name}
description: ${description}
---
body of ${name}`;
}

describe("loadSkills — 基础", () => {
  it("空目录 → 0 skills,0 errors", async () => {
    const { registry, errors } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("不存在的目录 → 0 skills,0 errors(不报错)", async () => {
    const { registry, errors } = await loadSkills("/tmp", {
      personalDir: "/nonexistent/personal",
      projectDir: "/nonexistent/project",
    });
    expect(registry.size()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("personal 一个 skill 正常加载", async () => {
    await writeSkill(personalDir, "deploy", skillContent("deploy"));
    const { registry, errors } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(errors).toEqual([]);
    expect(registry.size()).toBe(1);
    const file = registry.get("deploy");
    expect(file?.scope).toBe("personal");
    expect(file?.body).toContain("body of deploy");
  });
});

describe("loadSkills — 作用域覆盖", () => {
  it("project 同名 skill 覆盖 personal", async () => {
    await writeSkill(personalDir, "deploy", skillContent("deploy", "personal version description here"));
    await writeSkill(projectDir, "deploy", skillContent("deploy", "project version description here"));
    const { registry } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(1);
    const file = registry.get("deploy");
    expect(file?.scope).toBe("project");
    expect(file?.frontmatter.description).toContain("project version");
  });

  it("不同名 skill 并存", async () => {
    await writeSkill(personalDir, "a", skillContent("a"));
    await writeSkill(projectDir, "b", skillContent("b"));
    const { registry } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(2);
    expect(registry.get("a")?.scope).toBe("personal");
    expect(registry.get("b")?.scope).toBe("project");
  });
});

describe("loadSkills — disabled 黑名单", () => {
  it("disabled 列出的 name 跳过(两层都跳)", async () => {
    await writeSkill(personalDir, "deploy", skillContent("deploy"));
    await writeSkill(projectDir, "migrate", skillContent("migrate"));
    const { registry } = await loadSkills("/tmp", {
      personalDir,
      projectDir,
      disabled: ["deploy", "migrate"],
    });
    expect(registry.size()).toBe(0);
  });
});

describe("loadSkills — 错误兜底", () => {
  it("frontmatter 解析失败 → 进 errors,不阻塞其他 skill", async () => {
    await writeSkill(personalDir, "good", skillContent("good"));
    await writeSkill(personalDir, "bad", "no frontmatter at all");
    const { registry, errors } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(1);
    expect(registry.get("good")).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toContain("bad/SKILL.md");
    expect(errors[0].reason).toMatch(/missing frontmatter/);
  });

  it("目录无 SKILL.md → 不视为 skill,不报错", async () => {
    await mkdir(join(personalDir, "no-skill-md"), { recursive: true });
    await writeFile(join(personalDir, "no-skill-md", "README.md"), "not a skill");
    const { registry, errors } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("loadSkills — listInvocable 过滤", () => {
  it("disable-model-invocation=true 的 skill 不进 listInvocable", async () => {
    const visible = `---
name: visible
description: visible skill description here
---
body`;
    const hidden = `---
name: hidden
description: hidden skill description here
disable-model-invocation: true
---
body`;
    await writeSkill(personalDir, "visible", visible);
    await writeSkill(personalDir, "hidden", hidden);
    const { registry } = await loadSkills("/tmp", { personalDir, projectDir });
    expect(registry.size()).toBe(2);
    expect(registry.listInvocable().map((s) => s.name).sort()).toEqual(["visible"]);
    expect(registry.list().map((s) => s.name).sort()).toEqual(["hidden", "visible"]);
  });
});
