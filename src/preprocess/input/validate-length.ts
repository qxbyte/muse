/**
 * validate-length:超过 maxChars(默认 32k)截断 + warning。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2。
 */

import type { PipelineStage } from "../pipeline.js";
import type { InputCtx } from "./ctx.js";

const DEFAULT_MAX_CHARS = 32 * 1024;

export class ValidateLengthStage implements PipelineStage<InputCtx> {
  readonly name = "validate-length";

  run(ctx: InputCtx): void {
    const maxChars = ctx.settings.maxChars ?? DEFAULT_MAX_CHARS;
    if (ctx.text.length <= maxChars) return;
    const omitted = ctx.text.length - maxChars;
    ctx.text = ctx.text.slice(0, maxChars) + `\n... [truncated ${omitted} chars by validate-length]`;
    ctx.warnings.push({
      stage: this.name,
      message: `Input truncated: ${omitted} chars over ${maxChars} limit`,
    });
  }
}
