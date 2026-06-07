/**
 * ResultPipeline 上下文。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.1。
 */

import type { ToolExecuteResult } from "../../tools/types.js";

export type NormalizedErrorKind = "permission" | "timeout" | "not_found" | "network" | "binary" | "unknown";

export interface NormalizedError {
  kind: NormalizedErrorKind;
  message: string;
  raw?: string;
}

export interface ResultPreprocessSettings {
  truncate?: {
    /** 字节预算(默认 64KB)。 */
    budgetBytes?: number;
  };
  detectBinary?: {
    enabled?: boolean;
  };
  summarize?: {
    enabled?: boolean;
  };
  normalizeError?: {
    enabled?: boolean;
  };
  redact?: {
    /** 默认 true。 */
    enabled?: boolean;
  };
  /** inject-diff:把 diff 拼到 LLM 看见的 content 末尾(默认 false)。 */
  injectDiff?: boolean;
}

export interface ResultCtx {
  /** 工具名(用于 stage skip 判断与 hook matcher)。 */
  toolName: string;
  /** 工具调用 ID,与 tool_use 配对。 */
  toolUseId: string;
  /** 工具调用参数(只读;用于 summarize 等 stage 判断)。 */
  args: unknown;
  /** 工具返回的原始结构。 */
  raw: ToolExecuteResult;
  /** stage 累积修改的 content(回灌给 LLM 的最终文本)。 */
  content: string;
  /** stage 累积修改的 summary(顶部一行展示)。 */
  summary?: string;
  /** stage 累积修改的 diff(只用于 UI,不进 LLM)。 */
  diff?: string;
  /** 检测到的二进制告警。 */
  binaryDetected?: { reason: string; bytes: number };
  /** stage 标的错误归一化结果。 */
  normalizedError?: NormalizedError;
  /** 截断信息(给 UI / 日志参考)。 */
  truncated?: { omittedBytes: number };
  /** stage 标的告警。 */
  warnings: Array<{ stage: string; message: string }>;
  settings: ResultPreprocessSettings;
}

export function createResultCtx(init: {
  toolName: string;
  toolUseId: string;
  args: unknown;
  raw: ToolExecuteResult;
  settings?: ResultPreprocessSettings;
}): ResultCtx {
  return {
    toolName: init.toolName,
    toolUseId: init.toolUseId,
    args: init.args,
    raw: init.raw,
    content: init.raw.content,
    summary: init.raw.summary,
    diff: init.raw.diff,
    warnings: [],
    settings: init.settings ?? {},
  };
}
