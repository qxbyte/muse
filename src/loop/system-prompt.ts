/**
 * System prompt 构造。
 *
 * 简短、命令式：把可用工具与运行时约束直接摆出来给 LLM。
 * 中文输出由 ui.lang 控制；英文为默认。
 */

import { homedir } from "node:os";
import type { SkillFile } from "../skills/types.js";
import { renderAvailableSkillsSection } from "../skills/inject.js";

export interface SystemPromptOpts {
  cwd: string;
  model: string;
  provider: string;
  lang?: "en" | "zh-CN";
  toolNames: string[];
  /** MEMORY.md index 内容（loadMemoryIndex 加载后传入）；空串视为无 memory。 */
  memoryIndex?: string;
  /** 可见 skills(扩展接入口 §五.6);disable-model-invocation=true 的会被 inject 过滤掉。 */
  skills?: SkillFile[];
}

export function buildSystemPrompt(opts: SystemPromptOpts): string {
  const { cwd, model, provider, lang, toolNames, memoryIndex, skills } = opts;
  const home = homedir();
  const displayCwd = cwd.startsWith(home) ? cwd.replace(home, "~") : cwd;

  const sections: string[] = [];

  sections.push(`You are Muse, a CLI coding assistant. You are running on the user's local machine via a terminal interface.`);

  sections.push(
    `# Environment\n` +
      `- Working directory: ${displayCwd}\n` +
      `- LLM backend: ${provider} (${model})\n` +
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
  );

  // Skills 段(扩展接入口 §五.6)— 放在 Available tools 之前,因为 skill 决定
  // 用哪些 tool;LLM 看到 skill 后会按 skill 的流程驱动 tool 调用。
  if (skills && skills.length > 0) {
    const skillsSection = renderAvailableSkillsSection(skills);
    if (skillsSection) sections.push(skillsSection);
  }

  sections.push(
    `# Available tools\n` +
      toolNames.map((n) => `- ${n}`).join("\n") +
      `\n\nPrefer the dedicated tool over Bash when one fits (Read for file reading, Edit for partial updates, Write for new files / full rewrites, Grep for content search, Glob for file lookup).`,
  );

  sections.push(
    `# Behavior\n` +
      `- Be concise. State results, not your thinking. Don't narrate every step.\n` +
      `- Before editing a file you have not seen, Read it first.\n` +
      `- For Write/Edit/Bash the user may need to approve — proceed normally; the host will gate dangerous calls.\n` +
      `- If a command may be destructive (rm -rf, force push, drop table, etc.), warn first and let the user run it manually.\n` +
      `- When the user asks a question that does not need tools, just answer.`,
  );

  if (toolNames.includes("TodoWrite")) {
    sections.push(
      `# Task management\n` +
        `- For non-trivial, multi-step work, use TodoWrite to plan and track progress.\n` +
        `- Keep exactly one task in_progress; mark a task completed immediately when done.\n` +
        `- Skip it for trivial single-step requests.`,
    );
  }

  if (lang === "zh-CN") {
    sections.push(`# Output language\nReply in Chinese (简体中文) unless the user writes in English.`);
  }

  if (memoryIndex && memoryIndex.trim()) {
    sections.push(
      `# Memory (long-term)\n` +
        `Below is MEMORY.md — your index of persistent facts about the user, project, and prior feedback. ` +
        `Each line points at a file you can MemoryRead. Use MemoryWrite to record new durable knowledge ` +
        `(user role/preferences, validated decisions, project facts, external references). Do NOT save things ` +
        `derivable from the repo or git history.\n\n` +
        memoryIndex,
    );
  }

  return sections.join("\n\n");
}
