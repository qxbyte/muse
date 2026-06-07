/**
 * MemoryWrite / MemoryRead 工具:长期 memory 操作。
 *
 * 两层 scope(2026-06-07):
 *   - "project"(默认 / 安全偏向):跟当前 cwd 强相关的事实
 *   - "user":跨项目用户级偏好 / 工作风格
 *
 * 由 ctx.cwd 决定项目身份;切目录后 project memory 自动隔离;user memory 跨项目共享。
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import {
  readMemoryFile,
  writeMemory,
  type MemoryType,
  type Scope,
  SCOPES,
} from "../../loop/memory.js";

const TYPES: [MemoryType, ...MemoryType[]] = ["user", "feedback", "project", "reference"];
const SCOPE_VALUES: [Scope, ...Scope[]] = ["project", "user"];

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
  scope: z
    .enum(SCOPE_VALUES)
    .optional()
    .describe(
      'Storage scope. "project"(default — safe bias) = saved under current project, not visible to other projects. ' +
        '"user"(global) = saved under ~/.muse/memory/, visible across ALL projects. ' +
        "Choose carefully:\n" +
        "  scope=project — project architecture / file conventions / team agreements (pnpm vs npm) / project-specific bugs+fixes / API contracts.\n" +
        "    When unsure, choose project (safer; user can /memory promote-scope later).\n" +
        "  scope=user — user role / working language / timezone / cross-project editor preferences (tabs/spaces, naming style, comment language) / " +
        "tool preferences that apply EVERYWHERE / recurring feedback that reveals user personality.\n" +
        "  HARD RULE: personal preference items (tabs/spaces, comment language, editor) MUST be scope=user — " +
        "do NOT save them as project memory just because cwd is in a project. " +
        "If you cannot tell whether a fact is personal or project-specific, ask the user or default to project.",
    ),
});

export const MemoryWriteTool = defineTool({
  name: "MemoryWrite",
  description:
    "Save a long-term memory file under ~/.muse/[projects/<hash>/]memory/<name>.md and update MEMORY.md index. " +
    "Choose scope carefully (see scope arg). " +
    "Use for: user role/preferences (scope=user), validated approach decisions (feedback), " +
    "project facts (auto-convert relative dates), external system references. " +
    "Do NOT save: code patterns derivable from the repo, git history, fix recipes, ephemeral task state.",
  parameters: MemoryWriteArgs,
  permission: "write",
  summarize: (args) => `MemoryWrite(${args.name}, ${args.scope ?? "project"}, type=${args.type})`,
  async execute(args, ctx) {
    // LLM 自主写入强制 trust=auto + source=manual-write — LLM 不能自封 verified/trusted
    const result = await writeMemory(ctx.cwd, {
      name: args.name,
      description: args.description,
      type: args.type as MemoryType,
      body: args.body,
      trust: "auto",
      source: "manual-write",
      scope: args.scope as Scope | undefined, // defaults to "project" inside writeMemory
    });
    return {
      content: `Saved memory "${args.name}" (${args.type}, scope=${result.scope}, trust=auto) → ${result.filePath}${result.indexUpdated ? "\nMEMORY.md updated." : ""}`,
      summary: `MemoryWrite ${args.name} (${result.scope})`,
    };
  },
});

const MemoryReadArgs = z.object({
  name: z.string().describe("Memory slug to read (no .md extension)."),
  scope: z
    .enum(SCOPE_VALUES)
    .optional()
    .describe('Optional scope to read from. Default: project first, fallback user. Specify when name exists in both scopes.'),
});

export const MemoryReadTool = defineTool({
  name: "MemoryRead",
  description:
    "Read a specific long-term memory file by name. Default lookup: project scope first, then user scope. " +
    "Use after seeing it referenced in MEMORY.md (which is auto-injected into the system prompt). " +
    "Pass scope='project' or 'user' to disambiguate when the same name exists in both.",
  parameters: MemoryReadArgs,
  permission: "read",
  summarize: (args) => `MemoryRead(${args.name}${args.scope ? `, ${args.scope}` : ""})`,
  async execute(args, ctx) {
    try {
      const content = await readMemoryFile(ctx.cwd, args.name, args.scope as Scope | undefined);
      return { content, summary: `MemoryRead ${args.name}` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
});
