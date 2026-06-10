/**
 * Skills 注入 system-prompt 的两段文本:
 *
 *   1. renderAvailableSkillsSection — 短列表(每个 skill 一行 name+description+allowed-tools 摘要),
 *      永远拼到 system-prompt 末尾的 "Available skills" 段(平级于 "Available tools")。
 *
 *   2. renderActivatedSkillBody    — 触发后的 skill body 完整内容,拼到 system-prompt tail
 *      (易变区,对齐上下文管理工程 I-4 stable prefix / volatile tail 切分)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.6 / §五.7。
 */

import type { SkillFile } from "./types.js";

/** 短列表:供 LLM 自决参考(token 开销 ~50-100 per skill)。 */
export function renderAvailableSkillsSection(skills: SkillFile[]): string {
  const invocable = skills.filter((s) => !s.frontmatter["disable-model-invocation"]);
  if (invocable.length === 0) return "";

  const lines: string[] = [];
  lines.push("# Available skills");
  lines.push("");
  lines.push(
    "You can invoke any skill below by mentioning its name in your reasoning " +
      "(e.g. \"I'll use deploy-prod\"). Skills are user / project-provided workflows; " +
      "treat them as procedural guidance. The skill body will be appended to your context on the next turn.",
  );
  lines.push("");
  for (const s of invocable) {
    lines.push(formatSkillLine(s));
  }
  lines.push("");
  lines.push("Skills are layered: project (overrides) > personal. Use `/skill list` to inspect.");
  return lines.join("\n");
}

function formatSkillLine(s: SkillFile): string {
  const allowed = s.frontmatter["allowed-tools"];
  const tools = allowed && allowed.length > 0 ? ` (allowed: ${allowed.join(", ")})` : "";
  return `- **${s.name}** [${s.scope}] — ${s.frontmatter.description}${tools}`;
}

/** 触发后的完整 body:塞到 system-prompt tail(易变区)。 */
export function renderActivatedSkillBody(skills: SkillFile[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`# Skill activated: ${s.name}`);
    lines.push("");
    lines.push(s.body);
    lines.push("");
  }
  return lines.join("\n").trim();
}
