/**
 * 工具系统类型。
 * 内置工具与 MCP 工具都遵循同一接口。
 */

import type { z } from "zod";
import type { TodoStore } from "../loop/todos.js";

export type PermissionLevel = "read" | "write" | "execute" | "network";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** 询问用户对该工具调用的批准。返回 true=允许，false=拒绝。 */
  askPermission: (toolName: string, args: unknown, summary: string) => Promise<boolean>;
  /** 主代理可能想在工具内部发起子任务，预留口子。 */
  invokeSubagent?: (prompt: string) => Promise<string>;
  /** Session 内 todo 清单（TodoWrite 写入；system prompt 读取注入下一轮）。 */
  todos?: TodoStore;
}

export interface ToolExecuteResult {
  /** 给 LLM 看的文本结果。 */
  content: string;
  /** 标记为错误：让 LLM 知道需要修复。 */
  isError?: boolean;
  /** 给 TUI 展示的摘要（一行）。 */
  summary?: string;
  /** Unified diff（Write/Edit 等改文件工具填），交给 UI 渲染绿/红行；不进 LLM 上下文。 */
  diff?: string;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  /** zod schema 用于参数校验 + 自动转 JSON Schema。 */
  parameters: z.ZodType<TArgs>;
  /** 权限级别：UI 与 permission 模块据此决定 ask/allow/deny。 */
  permission: PermissionLevel;
  /** 一行摘要，给 TUI 在 "→ ToolName(...)" 之后显示。 */
  summarize?: (args: TArgs) => string;
  /** 实际执行函数。 */
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolExecuteResult>;
}

/** 类型擦除后的工具，用于 registry 存储 / 调用。 */
export interface AnyTool {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
  permission: PermissionLevel;
  summarize?: (args: unknown) => string;
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolExecuteResult>;
}

export function defineTool<TArgs>(def: ToolDefinition<TArgs>): AnyTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as z.ZodType<unknown>,
    permission: def.permission,
    summarize: def.summarize as ((args: unknown) => string) | undefined,
    execute: def.execute as (args: unknown, ctx: ToolContext) => Promise<ToolExecuteResult>,
  };
}
