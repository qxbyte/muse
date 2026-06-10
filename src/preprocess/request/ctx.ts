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
import type { MemoryIndex } from "../../loop/memory-index.js";
import type { SkillFile } from "../../skills/types.js";

export interface RequestPreprocessSettings {
  trimHistory?: {
    enabled?: boolean;
    budgetRatio?: number;
    /** 裁到此预算占比以下停手(默认 0.6,I-1 ADR #3)。 */
    targetRatio?: number;
    /** I-1:user 消息原文保护开关(默认 true)。 */
    preserveUserMessages?: boolean;
  };
  budgetGuard?: {
    enabled?: boolean;
    budgetRatio?: number;
    /** I-5:自动 compact 是否 promote facts(默认 true)。 */
    promoteFactsToMemory?: boolean;
  };
  /** I-2/O3/O4:compaction 子开关。 */
  compact?: {
    schema?: "9-section" | "6-section";
    fallbackOnFormatFail?: boolean;
    dedupPromotedFacts?: boolean;
  };
  /** O1:inject-memory 动态降量开关(默认 true)。 */
  injectMemory?: {
    budgetScaleEnabled?: boolean;
  };
  /** O2:image token 估算常量(默认 1500)。tokenize 模块在启动期一次性应用,
   *  此字段对 stage 而言只读;真正生效路径见 setImageTokenEstimate。 */
  tokenize?: {
    imageTokenEstimate?: number;
  };
  redact?: { enabled?: boolean };
  /** I-3 stale tool result clearing。默认开,keepRecentTurns=3,clearTools=[Read/Grep/Glob]。 */
  clearStaleToolResults?: {
    enabled?: boolean;
    keepRecentTurns?: number;
    clearTools?: string[];
  };
}

export interface RequestServices {
  todos: TodoStore;
  /** 已加载的 MEMORY.md 索引(由 app/cli 在 turn 前刷新一次后注入)。 */
  memoryIndex: string;
  /**
   * Skills 列表(扩展接入口 §五.6):build-system-prompt stage 注入 "Available skills" 短列表。
   * 整体 skill 集合是稳定的(启动期加载,/skill reload 才更新),适合放进 cache friendly prefix。
   * 激活后的 skill body 由 agent.ts 在 buildRequest 末尾拼到 tail(不进 stage)。
   */
  skills?: SkillFile[];
  /** 已加载的 hierarchy(MUSE.md / AGENTS.md 5 层)。II-1 引入。 */
  hierarchy?: HierarchyLayer[];
  /** 已构建的 memory 向量索引(II-5,settings.memory.embedding.enabled=true 时由 caller 注入)。 */
  memoryEmbeddingIndex?: MemoryIndex;
  /** memory.embedding.topK 配置;默认 5。 */
  memoryEmbeddingTopK?: number;
  /** memory.embedding.minMemoryCount;少于此值退化到全注入。默认 3(2026-06-07 R5 修订)。 */
  memoryEmbeddingMinCount?: number;
  /** memory.embedding.maxInjectTokens;注入预算上限,超出按 trust 优先级保留。默认 1500。 */
  memoryEmbeddingMaxInjectTokens?: number;
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
