/**
 * Grep 工具：基于 ripgrep 包装（若可用），fallback 到 bash grep。
 * v0.1 简单实现：直接调 system rg / grep。
 */

import { execa } from "execa";
import { z } from "zod";
import { defineTool } from "../types.js";

const GrepArgs = z.object({
  pattern: z.string().describe("Regex pattern to search for."),
  path: z.string().optional().describe("File or directory to search in. Default: cwd."),
  glob: z.string().optional().describe('Glob filter, e.g. "*.ts" or "src/**/*.tsx".'),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Default: files_with_matches."),
  context: z.number().int().min(0).max(50).optional().describe("Context lines around each match (use only with output_mode=content)."),
  case_insensitive: z.boolean().optional(),
});

let rgChecked = false;
let rgAvailable = false;

async function checkRipgrep(): Promise<boolean> {
  if (rgChecked) return rgAvailable;
  try {
    await execa("rg", ["--version"], { reject: false });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  rgChecked = true;
  return rgAvailable;
}

export const GrepTool = defineTool({
  name: "Grep",
  description: "Search file contents using regex. Prefer this over Bash(grep|find) — handles ignore files & is much faster on large trees.",
  parameters: GrepArgs,
  permission: "read",
  summarize: (args) => `Grep(${args.pattern}${args.path ? `, ${args.path}` : ""})`,
  async execute(args, ctx) {
    const hasRg = await checkRipgrep();
    const mode = args.output_mode ?? "files_with_matches";

    if (hasRg) {
      const cliArgs: string[] = [];
      if (args.case_insensitive) cliArgs.push("-i");
      if (mode === "files_with_matches") cliArgs.push("-l");
      else if (mode === "count") cliArgs.push("-c");
      else if (args.context != null) cliArgs.push("-C", String(args.context));
      if (args.glob) cliArgs.push("--glob", args.glob);
      cliArgs.push("--", args.pattern, args.path ?? ".");

      const result = await execa("rg", cliArgs, { cwd: ctx.cwd, reject: false, cancelSignal: ctx.abortSignal });
      const out = (result.stdout ?? "").trim();
      if (result.exitCode === 0 || result.exitCode === 1) {
        return { content: out || "(no matches)", summary: `Grep ${args.pattern}` };
      }
      return { content: `rg failed: ${result.stderr}`, isError: true };
    }

    // Fallback: bash grep -r
    const cliArgs = ["-r", "-n"];
    if (args.case_insensitive) cliArgs.push("-i");
    if (mode === "files_with_matches") cliArgs.push("-l");
    else if (mode === "count") cliArgs.push("-c");
    cliArgs.push("-E", args.pattern, args.path ?? ".");

    const result = await execa("grep", cliArgs, { cwd: ctx.cwd, reject: false, cancelSignal: ctx.abortSignal });
    const out = (result.stdout ?? "").trim();
    if (result.exitCode === 0 || result.exitCode === 1) {
      return { content: out || "(no matches)", summary: `Grep ${args.pattern}` };
    }
    return { content: `grep failed: ${result.stderr}`, isError: true };
  },
});
