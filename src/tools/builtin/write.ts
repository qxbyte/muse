/**
 * Write 工具：写入文件（创建或覆盖）。
 *
 * 为防误覆盖，约定调用前必须先 Read 过同一路径（除非文件不存在）。
 * 这个约束实际由 LLM 遵守 (prompt 引导)；本工具不强制，但记录到日志。
 */

import { writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, isAbsolute, dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "../types.js";

const WriteArgs = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path to the file."),
  content: z.string().describe("Full content of the file."),
});

export const WriteTool = defineTool({
  name: "Write",
  description: "Write a complete file to the local filesystem. Creates parent directories if needed. Overwrites existing files — prefer Edit for partial updates.",
  parameters: WriteArgs,
  permission: "write",
  summarize: (args) => `Write(${args.file_path}, ${args.content.length} chars)`,
  async execute(args, ctx) {
    const path = isAbsolute(args.file_path) ? args.file_path : resolve(ctx.cwd, args.file_path);

    let existed = false;
    try {
      const info = await stat(path);
      existed = info.isFile();
    } catch {
      // 文件不存在，正常情况
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, "utf-8");

    return {
      content: existed
        ? `Overwrote ${path} (${args.content.length} bytes).`
        : `Created ${path} (${args.content.length} bytes).`,
      summary: `${existed ? "Overwrote" : "Created"} ${args.file_path}`,
    };
  },
});
