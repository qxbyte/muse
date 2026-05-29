/**
 * 全局共享类型。其它模块按需 re-export 子集。
 * Why 集中：避免类型循环依赖。
 */

// ---------- 消息（与 LLM 交互的最小单元）----------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
}

export interface ToolMessage {
  role: "tool";
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Unified diff for UI display only (Write/Edit). Not sent to LLM. */
  diff?: string;
  /** UI-only one-line summary; if absent, UI falls back to content first line. */
  summary?: string;
  /** UI-only status dot color: success(green) / error(red) / warn(yellow). Default derived from isError. */
  kind?: "success" | "error" | "warn";
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------- LLM 工具定义（暴露给模型）----------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ---------- Token 用量 ----------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown";

// ---------- 错误 ----------

export class MuseError extends Error {
  constructor(message: string, public readonly code?: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MuseError";
  }
}

export class ToolError extends MuseError {
  constructor(message: string, public readonly toolName: string, cause?: unknown) {
    super(message, "TOOL_ERROR", cause);
    this.name = "ToolError";
  }
}

export class PermissionDeniedError extends MuseError {
  constructor(public readonly toolName: string, public readonly reason: string) {
    super(`Permission denied for ${toolName}: ${reason}`, "PERMISSION_DENIED");
    this.name = "PermissionDeniedError";
  }
}
