/**
 * OpenAI 兼容协议 provider。
 * 覆盖：OpenAI 官方、DeepSeek、Qwen、Moonshot (Kimi)、智谱、OpenRouter、Ollama (其 /v1 endpoint)、自建 vLLM/LocalAI 等。
 *
 * Why 自己包一层而不是直接用 @ai-sdk/openai-compatible:
 *   - 抹平 stream 事件差异，统一为本仓库的 LLMEvent 类型
 *   - 在 stream 中拼装 tool_call.arguments（OpenAI 流式 tool_call 是分片增量的 JSON 字符串）
 *   - 留口子未来插入降级、重试、token 计数估算
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, jsonSchema, tool, type CoreMessage, type ToolSet } from "ai";
import type {
  LLMClient,
  LLMEvent,
  ModelCapabilities,
  ProviderConfig,
  StreamOptions,
} from "../types.js";
import type { Message, AssistantMessage, ToolDefinition } from "../../types/index.js";
import { log, redactApiKey } from "../../log/index.js";

interface OpenAICompatibleProviderOpts {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  capabilities?: Partial<ModelCapabilities>;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
  parallelToolCalls: true,
  vision: false,
  jsonMode: true,
  maxContextWindow: 32_000,
};

export class OpenAICompatibleClient implements LLMClient {
  readonly providerName: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private modelProvider: ReturnType<ReturnType<typeof createOpenAICompatible>>;

  constructor(opts: OpenAICompatibleProviderOpts) {
    this.providerName = opts.providerName;
    this.model = opts.model;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };

    const provider = createOpenAICompatible({
      name: opts.providerName,
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
    });
    this.modelProvider = provider(opts.model);

    log.debug("LLM provider initialized", {
      provider: opts.providerName,
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKey: redactApiKey(opts.apiKey),
    });
  }

  async *stream(opts: StreamOptions): AsyncIterable<LLMEvent> {
    const { messages, tools, systemPrompt, temperature, maxTokens, abortSignal } = opts;

    const aiMessages = convertMessages(messages, systemPrompt);
    const aiTools = tools ? convertTools(tools) : undefined;

    // 重试：仅在还没收到任何 chunk 时（连接级错误）退避重试，最多 3 次
    let attempt = 0;
    const maxAttempts = 3;
    let result: ReturnType<typeof streamText> | undefined;
    while (true) {
      try {
        result = streamText({
          model: this.modelProvider,
          messages: aiMessages,
          tools: aiTools,
          temperature,
          maxTokens,
          abortSignal,
        });
        break;
      } catch (err) {
        if (abortSignal?.aborted) {
          yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
          return;
        }
        if (!isRetryable(err) || attempt >= maxAttempts - 1) {
          yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
          return;
        }
        const delay = 1000 * Math.pow(2, attempt);
        log.warn(`LLM connect failed (attempt ${attempt + 1}/${maxAttempts}); retrying in ${delay}ms`, {
          msg: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay, abortSignal);
        attempt += 1;
      }
    }

    if (!result) {
      yield { type: "error", error: new Error("Internal: stream result is undefined after retry loop.") };
      return;
    }
    const stream = result.fullStream;

    try {
      const seenToolCalls = new Set<string>();

      for await (const part of stream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text", delta: part.textDelta };
            break;

          case "tool-call":
            if (!seenToolCalls.has(part.toolCallId)) {
              seenToolCalls.add(part.toolCallId);
              yield { type: "tool_call_start", id: part.toolCallId, name: part.toolName };
            }
            yield {
              type: "tool_call_complete",
              id: part.toolCallId,
              name: part.toolName,
              args: part.args,
            };
            break;

          case "finish":
            yield {
              type: "finish",
              reason: mapFinishReason(part.finishReason),
              usage: part.usage
                ? {
                    inputTokens: part.usage.promptTokens ?? 0,
                    outputTokens: part.usage.completionTokens ?? 0,
                    totalTokens: part.usage.totalTokens ?? 0,
                  }
                : undefined,
            };
            break;

          case "error":
            yield { type: "error", error: part.error instanceof Error ? part.error : new Error(String(part.error)) };
            break;

          default:
            // 忽略其它（如 step-start / step-finish / tool-call-streaming-start 等）
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}

// ---------- helpers ----------

function convertMessages(messages: Message[], systemPrompt?: string): CoreMessage[] {
  const result: CoreMessage[] = [];
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        result.push({ role: "system", content: msg.content });
        break;
      case "user":
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else {
          const text = msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          result.push({ role: "user", content: text });
        }
        break;
      case "assistant":
        result.push({ role: "assistant", content: convertAssistantContent(msg) });
        break;
      case "tool":
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.toolUseId,
              toolName: "_tool",
              result: msg.content,
              isError: msg.isError ?? false,
            },
          ],
        });
        break;
    }
  }
  return result;
}

type AssistantContent = Extract<CoreMessage, { role: "assistant" }>["content"];

function convertAssistantContent(msg: AssistantMessage): AssistantContent {
  const parts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  > = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "tool_use") {
      parts.push({
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        args: part.args,
      });
    }
  }
  // 至少要有一个内容；空数组 SDK 会报错
  if (parts.length === 0) return "";
  return parts as AssistantContent;
}

function convertTools(tools: ToolDefinition[]): ToolSet {
  const result: ToolSet = {};
  for (const t of tools) {
    result[t.name] = tool({
      description: t.description,
      parameters: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
    });
  }
  return result;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as Error & { code?: string }).code ?? "";
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("under maintenance") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  ) {
    return true;
  }
  return false;
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort);
  });
}

function mapFinishReason(reason: string | undefined): "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown" {
  switch (reason) {
    case "stop":
    case "stop-sequence":
      return "stop";
    case "tool-calls":
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

// ---------- 预设 provider 工厂 ----------

export interface PresetConfig {
  baseUrl: string;
  defaultModel: string;
  capabilities?: Partial<ModelCapabilities>;
}

export const PRESETS: Record<string, PresetConfig> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    capabilities: { maxContextWindow: 128_000 },
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    capabilities: { maxContextWindow: 128_000 },
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    capabilities: { maxContextWindow: 32_000 },
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    capabilities: { maxContextWindow: 128_000 },
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    capabilities: { maxContextWindow: 8_000 },
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
  },
};

export function createPresetClient(
  providerName: string,
  config: ProviderConfig,
  model?: string,
): OpenAICompatibleClient {
  const preset = PRESETS[providerName];
  if (!preset) {
    throw new Error(`Unknown provider preset: ${providerName}. Available: ${Object.keys(PRESETS).join(", ")}`);
  }
  return new OpenAICompatibleClient({
    providerName,
    baseUrl: (config.baseUrl as string | undefined) ?? preset.baseUrl,
    apiKey: (config.apiKey as string | undefined) ?? "",
    model: model ?? preset.defaultModel,
    capabilities: preset.capabilities,
  });
}
