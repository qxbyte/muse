/**
 * budget-guard stage:trim-history 后兜底。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.4。
 * 触发阈值:budget × 0.95(trim 后仍超 → 调 compact;原设计默认值)。
 *
 * 顺序约束:必须排在 trim-history 之后。trim-history 已经裁掉一波又写好了
 * ctx.estimatedTokens,本 stage 只做最后的兜底。
 *
 * 失败处理:
 *   - 未配 services.compact 而又超阈值 → 抛 BudgetExceededError
 *   - compact 调用抛错 → 包成 BudgetExceededError
 *   - compact 成功但还超阈值 → 也抛 BudgetExceededError(意味着光 compact 也救不回来,
 *     需要用户介入)
 * Agent 捕获 BudgetExceededError → onError 报告给用户,turn 结束。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";
import { countMessages } from "../tokenize.js";

const DEFAULT_GUARD_RATIO = 0.95;

export class BudgetExceededError extends Error {
  constructor(
    public readonly estimated: number,
    public readonly budget: number,
    public readonly reason: string,
  ) {
    super(`context budget exceeded: estimated ${estimated} > budget ${budget} (${reason})`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetGuardStage implements PipelineStage<RequestCtx> {
  readonly name = "budget-guard";

  skip(ctx: RequestCtx): boolean {
    if (ctx.settings.budgetGuard?.enabled === false) return true;
    if (!ctx.services.contextWindow) return true;
    return false;
  }

  async run(ctx: RequestCtx): Promise<void> {
    const budget = ctx.services.contextWindow!;
    const guardRatio = ctx.settings.budgetGuard?.budgetRatio ?? DEFAULT_GUARD_RATIO;
    const triggerAt = budget * guardRatio;

    // trim-history 已经写了 estimatedTokens;若未写则现场算一次
    let estimated = ctx.estimatedTokens ?? countMessages(ctx.messages, ctx.systemPrompt, ctx.tools);
    ctx.estimatedTokens = estimated;
    if (estimated <= triggerAt) return;

    if (!ctx.services.compact) {
      throw new BudgetExceededError(estimated, budget, "no compact available and over 0.95 budget");
    }

    let compacted: import("../../types/index.js").Message[];
    try {
      compacted = await ctx.services.compact(ctx.services.abortSignal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BudgetExceededError(estimated, budget, `compact failed: ${msg}`);
    }

    ctx.messages = compacted;
    estimated = countMessages(compacted, ctx.systemPrompt, ctx.tools);
    ctx.estimatedTokens = estimated;
    if (estimated > triggerAt) {
      throw new BudgetExceededError(
        estimated,
        budget,
        "still over 0.95 budget after compact — context unrecoverable",
      );
    }
  }
}
