/**
 * Bash 工具：执行 shell 命令。
 *
 * 安全：内置 deny 列表（无法 allow 绕过）。
 * 上限：超时 + stdout 截断。
 */

import { execa } from "execa";
import { z } from "zod";
import { defineTool } from "../types.js";

const BashArgs = z.object({
  command: z.string().describe("Shell command to run. Will be executed via sh -c."),
  timeout: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 120000 (2 min). Max 600000."),
  description: z.string().optional().describe("Brief description (3-10 words) for the UI."),
});

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 100_000;

/** 即使在 allow 列表里也强制阻断的危险命令模式。 */
const HARD_DENY_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/,           // rm -rf /
  /\brm\s+-rf\s+~(?:\/|\s|$)/,         // rm -rf ~ or ~/...
  /\brm\s+-rf\s+\*/,                    // rm -rf *
  /\bdd\s+.*of=\/dev\//,                // dd of=/dev/*
  /\bmkfs\b/,                            // mkfs
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,    // fork bomb
  /\bsudo\b/,                            // sudo（v0.1 简单粗暴禁掉）
  /\bcurl\s+[^|]*\|\s*(?:sh|bash|zsh)/, // curl ... | sh
  /\bwget\s+[^|]*\|\s*(?:sh|bash|zsh)/, // wget ... | sh
];

function checkDangerous(command: string): { dangerous: true; reason: string } | { dangerous: false } {
  for (const pattern of HARD_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason: `matches pattern ${pattern}` };
    }
  }
  return { dangerous: false };
}

export const BashTool = defineTool({
  name: "Bash",
  description: "Execute a shell command via sh -c. Use for git, file system listings, builds, tests, etc. Avoid interactive commands (prefer non-interactive flags). For file edits use Edit/Write, not sed/echo.",
  parameters: BashArgs,
  permission: "execute",
  summarize: (args) => args.description ?? `Bash: ${args.command.length > 60 ? args.command.slice(0, 60) + "..." : args.command}`,
  async execute(args, ctx) {
    const danger = checkDangerous(args.command);
    if (danger.dangerous) {
      return {
        content: `Refused: command blocked by hard deny list (${danger.reason}). If you really need this, ask the user to run it manually.`,
        isError: true,
      };
    }

    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    try {
      const result = await execa(args.command, {
        shell: "/bin/sh",
        cwd: ctx.cwd,
        timeout,
        reject: false,
        stripFinalNewline: false,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cancelSignal: ctx.abortSignal,
      });

      const stdout = truncate(result.stdout ?? "", MAX_OUTPUT_BYTES, "stdout");
      const stderr = truncate(result.stderr ?? "", MAX_OUTPUT_BYTES, "stderr");

      const parts: string[] = [];
      if (stdout) parts.push(`<stdout>\n${stdout}\n</stdout>`);
      if (stderr) parts.push(`<stderr>\n${stderr}\n</stderr>`);
      if (result.timedOut) parts.push(`<timeout>Command exceeded ${timeout}ms.</timeout>`);
      if (result.failed && !result.timedOut) parts.push(`<exit_code>${result.exitCode ?? "unknown"}</exit_code>`);

      const body = parts.length > 0 ? parts.join("\n") : "(no output)";
      return {
        content: body,
        isError: result.failed,
        summary: result.failed ? `Bash exited ${result.exitCode ?? "?"}` : `Bash ok`,
      };
    } catch (err) {
      return {
        content: `Bash threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

function truncate(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [${label} truncated, original ${text.length} bytes]`;
}
