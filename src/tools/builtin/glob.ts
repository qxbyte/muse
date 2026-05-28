/**
 * Glob 工具：用 fast-glob 列出匹配文件。
 */

import fg from "fast-glob";
import { z } from "zod";
import { defineTool } from "../types.js";

const GlobArgs = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "**/*.{md,json}".'),
  path: z.string().optional().describe("Base directory to search from. Default: cwd."),
  limit: z.number().int().positive().max(1000).optional().describe("Max results. Default 100."),
});

const DEFAULT_LIMIT = 100;

export const GlobTool = defineTool({
  name: "Glob",
  description: "Find files by glob pattern. Returns relative paths sorted by modification time (newest first).",
  parameters: GlobArgs,
  permission: "read",
  summarize: (args) => `Glob(${args.pattern}${args.path ? `, ${args.path}` : ""})`,
  async execute(args, ctx) {
    const cwd = args.path ?? ctx.cwd;
    const limit = args.limit ?? DEFAULT_LIMIT;

    const entries = await fg(args.pattern, {
      cwd,
      onlyFiles: true,
      stats: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.muse/**"],
    });

    // 按 mtime 倒序
    entries.sort((a, b) => {
      const ta = a.stats?.mtime?.getTime() ?? 0;
      const tb = b.stats?.mtime?.getTime() ?? 0;
      return tb - ta;
    });

    const truncated = entries.length > limit;
    const paths = entries.slice(0, limit).map((e) => e.path);

    let result = paths.join("\n") || "(no matches)";
    if (truncated) {
      result += `\n... [${entries.length - limit} more, increase limit to see]`;
    }
    return { content: result, summary: `Glob found ${entries.length} file(s)` };
  },
});
