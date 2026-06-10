/**
 * Skills parser 单元测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.2。
 */

import { describe, it, expect } from "vitest";
import { parseSkillFile } from "../src/skills/parser.js";

const VALID = `---
name: deploy-prod
description: Deploy current branch to prod. Use when user asks to ship or release.
allowed-tools: [Bash, Read, Edit]
disable-model-invocation: false
---

# Deploy to Prod

## Steps

1. Run npm test
2. Run npm run build
`;

describe("parseSkillFile — happy path", () => {
  it("parses frontmatter + body of a typical SKILL.md", () => {
    const { frontmatter, body } = parseSkillFile(VALID);
    expect(frontmatter.name).toBe("deploy-prod");
    expect(frontmatter.description).toMatch(/Deploy current branch/);
    expect(frontmatter["allowed-tools"]).toEqual(["Bash", "Read", "Edit"]);
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toMatch(/^# Deploy to Prod/);
    expect(body).toMatch(/npm test/);
  });

  it("supports inline array with quoted strings", () => {
    const raw = `---
name: x
description: minimal valid description here for zod test
triggers: ["ship", 'release', deploy]
---
body`;
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter.triggers).toEqual(["ship", "release", "deploy"]);
  });

  it("supports boolean values", () => {
    const raw = `---
name: x
description: minimal valid description here for zod test
disable-model-invocation: true
---
body`;
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
  });

  it("ignores blank lines and # comments in frontmatter", () => {
    const raw = `---
# this is a comment
name: x

description: minimal valid description here for zod test
---
body`;
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter.name).toBe("x");
  });

  it("trims body whitespace", () => {
    const raw = `---
name: x
description: minimal valid description here for zod test
---

   leading and trailing whitespace
`;
    const { body } = parseSkillFile(raw);
    expect(body).toBe("leading and trailing whitespace");
  });
});

describe("parseSkillFile — validation errors", () => {
  it("throws on missing frontmatter", () => {
    expect(() => parseSkillFile("just markdown body")).toThrow(/missing frontmatter/);
  });

  it("throws on invalid name (uppercase / special chars)", () => {
    const raw = `---
name: Deploy-Prod
description: minimal valid description here for zod test
---
body`;
    expect(() => parseSkillFile(raw)).toThrow(/name/);
  });

  it("throws on description too short", () => {
    const raw = `---
name: x
description: hi
---
body`;
    expect(() => parseSkillFile(raw)).toThrow(/description/);
  });

  it("throws on description too long(>400 chars)", () => {
    const longDesc = "x".repeat(401);
    const raw = `---
name: x
description: ${longDesc}
---
body`;
    expect(() => parseSkillFile(raw)).toThrow(/description/);
  });

  it("throws on missing required field name", () => {
    const raw = `---
description: minimal valid description here for zod test
---
body`;
    expect(() => parseSkillFile(raw)).toThrow(/name/);
  });
});

describe("parseSkillFile — unknown frontmatter fields pass through", () => {
  it("passthrough preserves extra fields", () => {
    const raw = `---
name: x
description: minimal valid description here for zod test
custom-field: some-value
---
body`;
    const { frontmatter } = parseSkillFile(raw);
    expect((frontmatter as Record<string, unknown>)["custom-field"]).toBe("some-value");
  });
});
