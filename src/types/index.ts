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

/**
 * 通过 @file 引用进来的纯文本文件附件。
 *
 * 设计:作为独立 part 而不是 wrap XML 拼进 text,目的让 PDF / audio / video 等
 * 后续多模态 part 进来时不动协议层(模块设计/消息预处理工程/设计.md 等讨论 §1)。
 *
 * 下游 LLM client 视 provider 能力序列化:
 *   - 支持 file part 的 provider → 原生 file part
 *   - 不支持的 provider → 退化为 text wrap `<file path="...">…</file>`
 */
export interface FilePart {
  type: "file";
  path: string;
  /** RFC 6838 mime type;text/x-typescript / text/markdown 等;不强约束,信息性。 */
  mimeType?: string;
  /** 文本内容(utf-8)。 */
  text: string;
}

/**
 * 图片附件(@image.png 或拖拽 / 粘贴)。
 *
 * 用 base64 data URI 模式存,序列化为 OpenAI 兼容协议的 image_url part。
 */
export interface ImagePart {
  type: "image";
  /** image/png / image/jpeg / image/webp / image/gif。 */
  mediaType: string;
  /** base64 编码的图片字节。 */
  data: string;
  /** 来源路径(若有),用于 UI 展示与 LLM 上下文。 */
  path?: string;
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

export type ContentPart = TextPart | FilePart | ImagePart | ToolUsePart | ToolResultPart;

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
  /** 产生该结果的工具名；UI 据此做工具专属渲染（如 TodoWrite 隐藏结果行）。 */
  toolName?: string;
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
