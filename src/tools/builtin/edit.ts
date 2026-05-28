/**
 * Edit 工具：在文件中做精确字符串替换。
 *
 * 必须先 Read 过文件（由调用方/LLM 遵守，不强制校验）。
 * old_string 必须在文件中唯一出现；replace_all=true 时不要求唯一。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import { defineTool } from "../types.js";
import { ToolError } from "../../types/index.js";

const EditArgs = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path to the file."),
  old_string: z.string().describe("Exact substring to replace. Must be unique unless replace_all=true."),
  new_string: z.string().describe("Replacement string."),
  replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
});

export const EditTool = defineTool({
  name: "Edit",
  description: "Perform an exact string replacement in a file. Old string must be unique unless replace_all=true. Cheaper than Write when only a small part needs to change.",
  parameters: EditArgs,
  permission: "write",
  summarize: (args) => `Edit(${args.file_path})`,
  async execute(args, ctx) {
    const path = isAbsolute(args.file_path) ? args.file_path : resolve(ctx.cwd, args.file_path);

    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (err) {
      throw new ToolError(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, "Edit", err);
    }

    if (args.old_string === args.new_string) {
      return { content: "old_string is identical to new_string; nothing to do.", isError: true };
    }

    const occurrences = countOccurrences(content, args.old_string);
    if (occurrences === 0) {
      return {
        content: `old_string not found in ${args.file_path}. Did you read the file first? Check whitespace and indentation.`,
        isError: true,
      };
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        content: `old_string occurs ${occurrences} times in ${args.file_path}. Either expand context to make it unique, or set replace_all=true.`,
        isError: true,
      };
    }

    const newContent = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);

    await writeFile(path, newContent, "utf-8");

    return {
      content: `Edited ${path}: replaced ${args.replace_all ? occurrences : 1} occurrence(s).`,
      summary: `Edited ${args.file_path}`,
    };
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}
