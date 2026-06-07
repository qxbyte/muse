/**
 * RequestPipeline 上下文。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.1。
 */

import type { Message, ToolDefinition } from "../../types/index.js";
import type { PermissionMode } from "../../permission/index.js";
import type { TodoStore } from "../../loop/todos.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { HierarchyLayer } from "../../loop/hierarchy.js";

export interface RequestPreprocessSettings {
  trimHistory?: { enabled?: boolean; budgetRatio?: number };
  budgetGuard?: { enabled?: boolean; budgetRatio?: number };
  redact?: { enabled?: boolean };
}

export interface RequestServices {
  todos: TodoStore;
  /** 已加载的 MEMORY.md 索引(由 app/cli 在 turn 前刷新一次后注入)。 */
  memoryIndex: string;
  /** 已加载的 hierarchy(MUSE.md / AGENTS.md 5 层)。II-1 引入。 */
  hierarchy?: HierarchyLayer[];
  /** 工具注册中心,用于 toLLMDefinitions + tool 元数据。 */
  toolRegistry: ToolRegistry;
  /** 输出语言。 */
  lang?: "en" | "zh-CN";
  /** Provider 名(用于 system prompt 拼装)。 */
  provider: string;
  /** SessionStart hook 返回的额外 system prompt 片段(append 到 base 末尾)。 */
  extraSystemPrompt?: string;
  /** 当前模型可见上下文窗口(token 数);trim-history / budget-guard 用。
   *  未提供时这两个 stage 自动 skip。 */
  contextWindow?: number;
  /** 主动触发上下文压缩(budget-guard 用)。
   *  返回压缩后的新 messages。Agent 注入时会同步更新 agent.messages。
   *  抛错 = 压缩失败(LLM 调用失败 / hook block / 无可压缩内容等)。 */
  compact?: (abortSignal?: AbortSignal) => Promise<import("../../types/index.js").Message[]>;
  /** 本轮 abortSignal,透给 compact 用。 */
  abortSignal?: AbortSignal;
}

export interface RequestCtx {
  /** 当前 messages 数组(可变;stage 直接修改)。 */
  messages: Message[];
  /** 当前系统提示(stage 内累积拼装)。 */
  systemPrompt: string;
  /** 当前可见工具列表(plan 模式过滤后)。 */
  tools: ToolDefinition[];
  /** 模型 ID。 */
  modelId: string;
  /** 当前 PermissionMode。 */
  mode: PermissionMode;
  /** 估算的 prompt token 数;BudgetGuard 写入,后续 stage 可读。 */
  estimatedTokens?: number;
  /** settings.preprocess.request 配置。 */
  settings: RequestPreprocessSettings;
  /** 关联 services。 */
  services: RequestServices;
  /** 工作目录。 */
  cwd: string;
}

export function createRequestCtx(init: {
  messages: Message[];
  modelId: string;
  mode: PermissionMode;
  cwd: string;
  services: RequestServices;
  settings?: RequestPreprocessSettings;
}): RequestCtx {
  return {
    messages: init.messages,
    systemPrompt: "",
    tools: [],
    modelId: init.modelId,
    mode: init.mode,
    cwd: init.cwd,
    services: init.services,
    settings: init.settings ?? {},
  };
}
