/**
 * `/skill` slash 命令 — Skills 管理(list / info / run)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7.2。
 *
 * 子命令:
 *   /skill              → 等价 list
 *   /skill list         → 列所有已加载 skill(scope + invocable 标记)
 *   /skill info <name>  → 查看单个 skill 的 frontmatter + body
 *   /skill run <name>   → 强制触发 skill,绕过 LLM 自决(disable-model-invocation 也允许)
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.js";
import type { SkillFile, SkillRegistry } from "../skills/types.js";

export const SKILL: SlashCommand = {
  name: "skill",
  description: "manage skills (list / info / run)",
  argsHint: "[list | info <name> | run <name>]",
  execute(ctx: SlashCommandContext): SlashCommandResult {
    const args = ctx.args.trim();
    if (!args || args === "list") return runList(ctx.skillRegistry);

    const [sub, ...rest] = args.split(/\s+/);
    const name = rest.join(" ").trim();
    if (sub === "info") return runInfo(ctx.skillRegistry, name);
    if (sub === "run") return runActivate(ctx, name);

    return { display: usageHelp() };
  },
};

function runList(registry: SkillRegistry | undefined): SlashCommandResult {
  if (!registry) return { display: "Skills not enabled. Set settings.skills.enabled=true and add SKILL.md files." };
  const all = registry.list();
  if (all.length === 0) {
    return {
      display:
        "No skills found.\n\n" +
        "Add a skill at one of:\n" +
        "  ~/.muse/skills/<name>/SKILL.md       (personal, cross-project)\n" +
        "  <cwd>/.muse/skills/<name>/SKILL.md   (project, may be committed)",
    };
  }
  const lines: string[] = [`Skills (${all.length} total):`];
  for (const s of sortedByScope(all)) {
    const hidden = s.frontmatter["disable-model-invocation"] ? " [hidden]" : "";
    lines.push(`  [${s.scope}]${hidden} ${s.name} — ${s.frontmatter.description}`);
  }
  lines.push("");
  lines.push("Use `/skill info <name>` to see body, `/skill run <name>` to force-activate.");
  return { display: lines.join("\n") };
}

function runInfo(registry: SkillRegistry | undefined, name: string): SlashCommandResult {
  if (!registry) return { display: "Skills not enabled." };
  if (!name) return { display: "Usage: /skill info <name>" };
  const skill = registry.get(name);
  if (!skill) return { display: `Skill "${name}" not found. Run \`/skill list\` to see available.` };
  return { display: renderSkillInfo(skill) };
}

function runActivate(ctx: SlashCommandContext, name: string): SlashCommandResult {
  if (!name) return { display: "Usage: /skill run <name>" };
  const reason = ctx.actions.activateSkill(name);
  if (reason) return { display: `Failed to activate skill: ${reason}` };
  return { display: `Skill "${name}" activated. Its body will be injected on the next LLM turn.` };
}

function sortedByScope(files: SkillFile[]): SkillFile[] {
  return [...files].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function renderSkillInfo(s: SkillFile): string {
  const fm = s.frontmatter;
  const lines: string[] = [];
  lines.push(`# ${s.name}  [${s.scope}]`);
  lines.push("");
  lines.push(`description:           ${fm.description}`);
  lines.push(`allowed-tools:        ${fm["allowed-tools"]?.join(", ") ?? "(any)"}`);
  lines.push(`disable-model-invoc:  ${fm["disable-model-invocation"] ?? false}`);
  lines.push(`triggers:             ${fm.triggers?.join(", ") ?? "(none)"}`);
  lines.push(`file:                 ${s.filePath}`);
  lines.push("");
  lines.push("--- Body ---");
  lines.push(s.body);
  return lines.join("\n");
}

function usageHelp(): string {
  return [
    "Usage:",
    "  /skill                  list all loaded skills",
    "  /skill list             same as above",
    "  /skill info <name>      show full SKILL.md content",
    "  /skill run <name>       force-activate the skill (bypasses LLM auto-detection)",
  ].join("\n");
}
