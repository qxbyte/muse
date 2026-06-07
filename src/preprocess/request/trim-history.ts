/**
 * trim-history stage:基于 token 预算的滑动窗口/优先级裁剪。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.3。
 * ADR #3:触发阈值 budget × 0.8,裁剪到 budget × 0.6 以下停手(2026-06-07 拍板)。
 *
 * 策略:
 *   1. 估算总 prompt token(systemPrompt + messages + tools)
 *   2. 未超阈值 → 写 estimatedTokens 后 no-op
 *   3. 超阈值:
 *      - 保第一条 user(initial task,通常是用户原始诉求)
 *      - 找一个安全切点 keepStart 使得 [0] + [keepStart..end] 落入 0.6 budget
 *      - 安全切点 = 不破坏 tool_use ↔ tool_result 配对(复用 findSafeCutoff)
 *      - 中间裁掉的段用一条 user marker 替代,让 LLM 知道有上下文丢失
 *
 * 不污染 agent.messages:替换 ctx.messages 整体引用,不就地 splice/mutate。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";
import type { Message } from "../../types/index.js";
import { countMessages } from "../tokenize.js";
import { findSafeCutoff } from "../../loop/context.js";

const DEFAULT_TRIM_RATIO = 0.8;
const TARGET_RATIO = 0.6;
const MIN_KEEP_RECENT = 4;
const MAX_KEEP_RECENT = 24;

export class TrimHistoryStage implements PipelineStage<RequestCtx> {
  readonly name = "trim-history";

  skip(ctx: RequestCtx): boolean {
    if (ctx.settings.trimHistory?.enabled === false) return true;
    // 没有 contextWindow 信息无法计算预算,直接跳过(默认是 200k,但只用于
    // 显式配置时才裁;不配则视作"模型方自己处理"不动)
    if (!ctx.services.contextWindow) return true;
    return false;
  }

  run(ctx: RequestCtx): void {
    const budget = ctx.services.contextWindow!;
    const trimRatio = ctx.settings.trimHistory?.budgetRatio ?? DEFAULT_TRIM_RATIO;
    const triggerAt = budget * trimRatio;
    const targetAt = budget * TARGET_RATIO;

    const initial = countMessages(ctx.messages, ctx.systemPrompt, ctx.tools);
    ctx.estimatedTokens = initial;
    if (initial <= triggerAt) return;

    const trimmed = trimMessages(ctx.messages, targetAt, ctx.systemPrompt, ctx.tools);
    if (trimmed === ctx.messages) return;

    ctx.messages = trimmed;
    ctx.estimatedTokens = countMessages(trimmed, ctx.systemPrompt, ctx.tools);
  }
}

/**
 * 从小 keepRecent 起步(裁得激进),命中 target 后返回。
 *
 * 为什么不从大 keepRecent 起手:大 keepRecent 对应 cutoff 很小(甚至 cutoff=1),
 * 此时 [messages[0], marker, ...slice(1)] 反而比原 messages 多 1 条 marker —
 * 没起到裁剪作用还增加 token。
 *
 * MIN_TRIM_COUNT 保底:cutoff 必须 >= 2(至少裁掉 2 条原 message),否则视作没裁。
 *
 * 返回新数组(不就地 mutate);裁不下来时返原数组。
 */
const MIN_TRIM_COUNT = 2;

function trimMessages(
  messages: Message[],
  targetTokens: number,
  systemPrompt: string,
  tools: import("../../types/index.js").ToolDefinition[],
): Message[] {
  if (messages.length <= MIN_KEEP_RECENT + 2) return messages;

  let bestTrimmed: Message[] | undefined;

  // 从激进(小 keepRecent)往保守(大 keepRecent)走;命中 target 立刻 return
  for (let keepRecent = MIN_KEEP_RECENT; keepRecent <= MAX_KEEP_RECENT; keepRecent++) {
    if (keepRecent >= messages.length - 1) break;
    const cutoff = findSafeCutoff(messages, keepRecent);
    if (cutoff < MIN_TRIM_COUNT) continue;

    const marker: Message = {
      role: "user",
      content: `[${cutoff - 1} earlier message${cutoff - 1 === 1 ? "" : "s"} trimmed to fit context window]`,
    };
    const trimmed: Message[] = [messages[0], marker, ...messages.slice(cutoff)];
    const tokens = countMessages(trimmed, systemPrompt, tools);
    if (tokens <= targetTokens) return trimmed;
    // 没命中但记下最激进的尝试,作为兜底
    if (!bestTrimmed) bestTrimmed = trimmed;
  }

  // 所有 keepRecent 都裁不到 target 以下 — 返回最激进的那次(已是最大努力)
  return bestTrimmed ?? messages;
}
