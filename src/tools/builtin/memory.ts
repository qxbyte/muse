/**
 * MemoryWrite / MemoryRead 工具：长期 memory 操作。
 *
 * Memory 设计与 Claude Code 对齐：四种类型（user / feedback / project / reference），
 * 文件路径在 ~/.muse/projects/<hash>/memory/，MEMORY.md 索引注入到 system prompt。
 *
 * 由 ctx.cwd 决定项目身份；切目录后 memory 自动隔离。
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import { readMemoryFile, writeMemory, type MemoryType } from "../../loop/memory.js";

const TYPES: [MemoryType, ...MemoryType[]] = ["user", "feedback", "project", "reference"];

const MemoryWriteArgs = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "must be a kebab- or snake-style slug")
    .describe("Short kebab/snake slug; used as filename (<name>.md) and index key."),
  description: z
    .string()
    .describe("One-line summary used in MEMORY.md index (decides future relevance)."),
  type: z.enum(TYPES).describe("user | feedback | project | reference"),
  body: z.string().describe("Memory content (markdown). For feedback/project, lead with the rule/fact then **Why:** and **How to apply:** lines."),
});

export const MemoryWriteTool = defineTool({
  name: "MemoryWrite",
  description:
    "Save a long-term memory file under ~/.muse/projects/<hash>/memory/<name>.md and update MEMORY.md index. " +
    "Use for: user role/preferences, validated approach decisions (feedback), project facts (auto-convert relative dates), external system references. " +
    "Do NOT save: code patterns derivable from the repo, git history, fix recipes, ephemeral task state.",
  parameters: MemoryWriteArgs,
  permission: "write",
  summarize: (args) => `MemoryWrite(${args.name}, type=${args.type})`,
  async execute(args, ctx) {
    const { filePath, indexUpdated } = await writeMemory(ctx.cwd, {
      name: args.name,
      description: args.description,
      type: args.type as MemoryType,
      body: args.body,
    });
    return {
      content: `Saved memory "${args.name}" (${args.type}) → ${filePath}${indexUpdated ? "\nMEMORY.md updated." : ""}`,
      summary: `MemoryWrite ${args.name}`,
    };
  },
});

const MemoryReadArgs = z.object({
  name: z.string().describe("Memory slug to read (no .md extension)."),
});

export const MemoryReadTool = defineTool({
  name: "MemoryRead",
  description:
    "Read a specific long-term memory file by name. Use after seeing it referenced in MEMORY.md (which is auto-injected into the system prompt).",
  parameters: MemoryReadArgs,
  permission: "read",
  summarize: (args) => `MemoryRead(${args.name})`,
  async execute(args, ctx) {
    try {
      const content = await readMemoryFile(ctx.cwd, args.name);
      return { content, summary: `MemoryRead ${args.name}` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
});
