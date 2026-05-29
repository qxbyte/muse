/**
 * System prompt 构造。
 *
 * 简短、命令式：把可用工具与运行时约束直接摆出来给 LLM。
 * 中文输出由 ui.lang 控制；英文为默认。
 */

import { homedir } from "node:os";

export interface SystemPromptOpts {
  cwd: string;
  model: string;
  provider: string;
  lang?: "en" | "zh-CN";
  toolNames: string[];
}

export function buildSystemPrompt(opts: SystemPromptOpts): string {
  const { cwd, model, provider, lang, toolNames } = opts;
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

  return sections.join("\n\n");
}
