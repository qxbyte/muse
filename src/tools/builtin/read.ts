/**
 * Read 工具：读取本地文件，支持 offset/limit 分页。
 * 返回带行号的 `cat -n` 格式，方便 LLM 引用具体行做编辑。
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import { defineTool } from "../types.js";
import { ToolError } from "../../types/index.js";
import { checkSensitivePath } from "../_sensitive.js";

const ReadArgs = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path to the file."),
  offset: z.number().int().min(0).optional().describe("Line offset (0-based)."),
  limit: z.number().int().positive().optional().describe("Max lines to read. Default 2000."),
});

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000; // 单行超长时截断

export const ReadTool = defineTool({
  name: "Read",
  description: "Read a file from the local filesystem. Returns content with 1-indexed line numbers (cat -n format). Use offset/limit for large files.",
  parameters: ReadArgs,
  permission: "read",
  summarize: (args) => `Read(${args.file_path}${args.offset != null ? `, offset=${args.offset}` : ""}${args.limit != null ? `, limit=${args.limit}` : ""})`,
  async execute(args, ctx) {
    const path = isAbsolute(args.file_path) ? args.file_path : resolve(ctx.cwd, args.file_path);

    const sensitive = checkSensitivePath(path);
    if (sensitive.blocked) {
      return { content: `Refused: ${path} matches sensitive path policy (${sensitive.reason}).`, isError: true };
    }

    let info;
    try {
      info = await stat(path);
    } catch (err) {
      throw new ToolError(`File not found: ${path}`, "Read", err);
    }

    if (!info.isFile()) {
      throw new ToolError(`Not a regular file: ${path}`, "Read");
    }

    const content = await readFile(path, "utf-8");
    const lines = content.split(/\r?\n/);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(offset, offset + limit);

    const numbered = slice.map((line, i) => {
      const lineNo = offset + i + 1;
      const truncated = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "... [truncated]" : line;
      return `${String(lineNo).padStart(5, " ")}\t${truncated}`;
    });

    let result = numbered.join("\n");
    if (offset + limit < lines.length) {
      result += `\n... [${lines.length - offset - limit} more lines, use offset=${offset + limit} to read next]`;
    }

    return {
      content: result || "(empty file)",
      summary: `Read ${slice.length} lines from ${args.file_path}`,
    };
  },
});
