/**
 * TodoWrite 工具：维护当前会话的任务清单（仿 Claude Code 的 todo 列表）。
 *
 * 纯会话内状态：不落盘、不碰文件系统。每次调用用完整列表覆盖旧列表，
 * 渲染由 MessageView 特判 name === "TodoWrite" 时读 args.todos 画 checkbox 清单。
 */

import { z } from "zod";
import { defineTool } from "../types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

const TodoItemSchema = z.object({
  content: z.string().describe("Imperative form of the task, e.g. 'Run the test suite'."),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z
    .string()
    .optional()
    .describe("Present-continuous form shown while in progress, e.g. 'Running the test suite'."),
});

const TodoWriteArgs = z.object({
  todos: z.array(TodoItemSchema).describe("The complete todo list. Replaces the previous list entirely."),
});

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

function countByStatus(todos: TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of todos) counts[t.status]++;
  return counts;
}

export const TodoWriteTool = defineTool({
  name: "TodoWrite",
  description:
    "Maintain a structured task list for the current session. Use it to plan multi-step work and keep the user informed of progress. " +
    "Pass the COMPLETE list every call — it replaces the previous one. Keep exactly one task in_progress at a time, and mark a task completed as soon as it is done.",
  parameters: TodoWriteArgs,
  permission: "read",
  summarize: (args) => `TodoWrite(${args.todos.length} tasks)`,
  async execute(args) {
    const counts = countByStatus(args.todos);
    const header = `Todos updated (${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending).`;
    const lines = args.todos.map((t) => {
      const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
      return `${MARK[t.status]} ${label}`;
    });
    return {
      content: [header, ...lines].join("\n"),
      summary: header,
    };
  },
});
