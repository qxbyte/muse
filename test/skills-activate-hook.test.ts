/**
 * SkillActivate hook 测试(扩展接入口 §五.9)。
 *
 * fireSkillActivateHook 在 skill 激活前触发 SkillActivate hook,
 * hook 返回 block → 该 skill 不激活(返回 block reason)。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fireSkillActivateHook } from "../src/skills/agent-bridge.js";
import type { HooksConfig } from "../src/preprocess/hooks.js";
import type { SkillFile } from "../src/skills/types.js";

function mkSkill(name: string, allowed?: string[]): SkillFile {
  return {
    name,
    frontmatter: {
      name,
      description: `${name} description goes here for zod validation`,
      "allowed-tools": allowed,
    },
    body: `# ${name}`,
    filePath: `/fake/${name}/SKILL.md`,
    dirPath: `/fake/${name}`,
    scope: "project",
  };
}

let dir: string;
/** 输出 {"block":{"reason":"..."}} 的可执行 hook 脚本。 */
let blockScript: string;
/** 不输出(放行)的 hook 脚本。 */
let passScript: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-skillhook-"));
  blockScript = join(dir, "block.js");
  passScript = join(dir, "pass.js");
  writeFileSync(
    blockScript,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ block: { reason: "skill blocked by policy" } }));\n`,
  );
  writeFileSync(passScript, `#!/usr/bin/env node\nprocess.exit(0);\n`);
  chmodSync(blockScript, 0o755);
  chmodSync(passScript, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fireSkillActivateHook", () => {
  it("无 SkillActivate hook 配置 → 放行(返回 null)", async () => {
    expect(await fireSkillActivateHook(mkSkill("deploy"), undefined)).toBeNull();
    expect(await fireSkillActivateHook(mkSkill("deploy"), {})).toBeNull();
  });

  it("hook 不 block(脚本无输出)→ 放行", async () => {
    const hooks: HooksConfig = { SkillActivate: [{ command: passScript }] };
    expect(await fireSkillActivateHook(mkSkill("deploy"), hooks)).toBeNull();
  });

  it("hook block → 返回 reason", async () => {
    const hooks: HooksConfig = { SkillActivate: [{ command: blockScript }] };
    const reason = await fireSkillActivateHook(mkSkill("deploy"), hooks);
    expect(reason).toBe("skill blocked by policy");
  });

  it("matcher 按 skillName 过滤:不匹配 → 不触发 → 放行", async () => {
    // matcher 只对 deploy-* 生效;对 build 这个 skill 不触发(故不会 block)
    const hooks: HooksConfig = { SkillActivate: [{ command: blockScript, matcher: "^deploy-" }] };
    expect(await fireSkillActivateHook(mkSkill("build"), hooks)).toBeNull();
  });

  it("matcher 匹配 skillName → 触发 → block", async () => {
    const hooks: HooksConfig = { SkillActivate: [{ command: blockScript, matcher: "^deploy-" }] };
    const reason = await fireSkillActivateHook(mkSkill("deploy-prod"), hooks);
    expect(reason).toBe("skill blocked by policy");
  });
});
