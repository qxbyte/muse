/**
 * LLM 抽象层类型。
 * 业务（Agent loop）只看到这些类型，不感知具体 provider。
 */

import type { Message, ToolDefinition, TokenUsage, FinishReason } from "../types/index.js";

export interface StreamOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export type LLMEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsDelta: string }
  | { type: "tool_call_complete"; id: string; name: string; args: unknown }
  | { type: "finish"; reason: FinishReason; usage?: TokenUsage }
  | { type: "error"; error: Error };

export interface ModelCapabilities {
  toolCalling: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  jsonMode: boolean;
  maxContextWindow: number;
}

export interface LLMClient {
  readonly providerName: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  stream(opts: StreamOptions): AsyncIterable<LLMEvent>;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  [key: string]: unknown;
}

export interface LLMConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}
