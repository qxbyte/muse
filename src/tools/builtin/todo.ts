/**
 * TodoWrite 工具：维护 session 内任务清单。
 *
 * 把完整 todos 数组替换进 ctx.todos。约定：一次只一个 in_progress；完成立即标 completed
 * 不要批；任务尽量原子。MessageView 会读 args.todos 渲染 checkbox 清单。
 */

import { z } from "zod";
import { defineTool } from "../types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

const TodoSchema = z.object({
  content: z.string().describe("Imperative one-line task description (e.g. 'Run the test suite')."),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Current status."),
  activeForm: z.string().optional().describe("Present-continuous form for the spinner (e.g. 'Running the test suite')."),
});

const TodoWriteArgs = z.object({
  todos: z.array(TodoSchema).describe("Full list. Replaces the current store."),
  listTitle: z
    .string()
    .optional()
    .describe(
      "Short (2-6 word) imperative title describing the OVERALL goal of this todo list, e.g. " +
        "'Refactor auth flow' / '分析 Muse 架构' / 'Migrate to ESM'. Shown as the list header in UI. " +
        "Keep it stable across calls within the same task; only change it if the goal genuinely shifts.",
    ),
});

export const TodoWriteTool = defineTool({
  name: "TodoWrite",
  description:
    "Maintain a structured task list for the current session. Pass the FULL list every call (it replaces the store). " +
    "Mark exactly one task in_progress at a time; mark completed immediately when done; do not batch completions. " +
    "Use when the task has 3+ distinct steps or is non-trivial. Skip for single trivial actions. " +
    "Always include `listTitle` summarizing the overall goal so the UI can label this batch meaningfully.",
  parameters: TodoWriteArgs,
  permission: "read",
  summarize: (args) => `TodoWrite(${args.todos.length} items)`,
  async execute(args, ctx) {
    if (!ctx.todos) {
      return {
        content: "TodoWrite is unavailable: this agent run has no todo store. (Internal bug; tell the user.)",
        isError: true,
      };
    }
    ctx.todos.set(args.todos);
    const summary = args.todos
      .map((t, i) => `${i + 1}. ${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`)
      .join("\n");
    return {
      content: `Updated todos (${args.todos.length} items):\n${summary}`,
      summary: `Todos: ${args.todos.filter((t) => t.status === "completed").length}/${args.todos.length} done`,
    };
  },
});
