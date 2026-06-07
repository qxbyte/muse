/**
 * Token 计数:基于 js-tiktoken(纯 JS,无 WASM 依赖)。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.3 trim-history / §4.2.4 budget-guard
 * ADR:暂用 cl100k_base 作为跨 provider 通用编码。OpenAI / DeepSeek / Qwen / Kimi
 * 系实际编码各异,但 trim/budget 的 0.8/0.95 阈值已留出 ~20% safety margin,
 * 不同 provider 真实 token 数偏差通常在 ±20% 内可吸收。后续需要 provider-aware
 * 时只改 getEncoder() 一处。
 *
 * 单例 encoder:getEncoding 内部已经做了缓存,但模块级 once 更明确。
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { Message, ToolDefinition } from "../types/index.js";

let _enc: Tiktoken | undefined;
function enc(): Tiktoken {
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

/** 计单段文本的 token 数。空字符串返 0。 */
export function countText(text: string): number {
  if (!text) return 0;
  return enc().encode(text).length;
}

/**
 * 计一组 messages + 可选 systemPrompt + 可选 tools 的总 prompt token 数。
 *
 * - text part 直接 encode
 * - tool_use part:name + JSON.stringify(args)
 * - tool result(role="tool"):content 字符串
 * - file / image part:占位文本(图像真实 token 由 vision 模型另计,这里无法预知)
 * - tools 定义:JSON.stringify 后 encode
 *
 * 这是上层 RequestPipeline / Agent estimateInputTokens 的统一入口。
 */
export function countMessages(
  messages: Message[],
  systemPrompt?: string,
  tools?: ToolDefinition[],
): number {
  let total = 0;
  if (systemPrompt) total += countText(systemPrompt);

  for (const m of messages) {
    if (m.role === "tool") {
      total += countText(m.content);
      continue;
    }
    const content = m.content;
    if (typeof content === "string") {
      total += countText(content);
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p.type === "text") total += countText(p.text ?? "");
        else if (p.type === "tool_use") {
          total += countText(p.name) + countText(JSON.stringify(p.args ?? {}));
        } else if (p.type === "file") {
          // file part 在 client 序列化时 wrap 为 <file path="...">...</file> 送 LLM;
          // 估算时把 path + text 全算上,避免 file 附件 token 数被漏估
          total += countText(p.path) + countText(p.text);
        } else if (p.type === "image") {
          // vision token 由模型方按 tile/resolution 计费,prompt 侧用占位估算
          total += countText(`[image: ${p.path ?? p.mediaType}]`);
        }
      }
    }
  }

  if (tools && tools.length > 0) {
    // tools 整段 JSON 序列化 — 与发给 LLM 的 schema 形态最接近的近似
    for (const t of tools) total += countText(JSON.stringify(t));
  }

  return total;
}

/**
 * 单条 message 的 token 数(trim-history 逐条估算用)。
 */
export function countMessage(m: Message): number {
  return countMessages([m]);
}
