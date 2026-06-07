/**
 * truncate:统一截断算法,字节预算 64KB / 工具,超出尾部加 marker。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2、§5.1。
 */

import type { PipelineStage } from "../pipeline.js";
import { truncate } from "../truncate.js";
import type { ResultCtx } from "./ctx.js";

export class TruncateStage implements PipelineStage<ResultCtx> {
  readonly name = "truncate";

  skip(ctx: ResultCtx): boolean {
    return ctx.binaryDetected != null;
  }

  run(ctx: ResultCtx): void {
    const budgetBytes = ctx.settings.truncate?.budgetBytes;
    const result = truncate(ctx.content, budgetBytes ? { budgetBytes } : {});
    if (!result.truncated) return;
    ctx.content = result.content;
    ctx.truncated = { omittedBytes: result.omittedBytes };
    ctx.warnings.push({
      stage: this.name,
      message: `Truncated ${result.omittedBytes} bytes`,
    });
  }
}
