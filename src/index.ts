/**
 * Library entry — exports core building blocks so 3rd-party code (or future MCP server) can embed Muse.
 */

export { createLLMClient, PRESETS } from "./llm/index.js";
export type { LLMClient, LLMEvent, StreamOptions } from "./llm/index.js";

export { ToolRegistry, defineTool, BUILTIN_TOOLS } from "./tools/index.js";
export type { ToolContext, ToolDefinition, AnyTool, PermissionLevel } from "./tools/index.js";

export { PermissionGate } from "./permission/index.js";
export type { Decision } from "./permission/index.js";

export { Session } from "./session/index.js";
export type { SessionEvent, SessionMeta } from "./session/index.js";

export { Agent, buildSystemPrompt } from "./loop/index.js";
export type { AgentContext, AgentEvents } from "./loop/index.js";

export { loadSettings, SettingsSchema } from "./config/index.js";
export type { Settings, LLMConfig, ProviderConfig, Permissions } from "./config/index.js";

export { log, redactApiKey } from "./log/index.js";

export type {
  Message,
  AssistantMessage,
  UserMessage,
  ToolMessage,
  SystemMessage,
  ContentPart,
  TextPart,
  ToolUsePart,
  ToolResultPart,
  TokenUsage,
  FinishReason,
} from "./types/index.js";

export { MuseError, ToolError, PermissionDeniedError } from "./types/index.js";
