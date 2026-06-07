/**
 * redact-pre-scan:用 redact 规则扫用户输入,命中替换为 [REDACTED] + warning。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2、§5.2。
 *
 * 这里默认开启:用户粘贴含 API key 的代码进 LLM 是高频风险点,先兜底再说。
 */

import type { PipelineStage } from "../pipeline.js";
import { redact } from "../redact.js";
import type { InputCtx } from "./ctx.js";

export class RedactPreScanStage implements PipelineStage<InputCtx> {
  readonly name = "redact-pre-scan";

  skip(ctx: InputCtx): boolean {
    return ctx.settings.redactPreScan?.enabled === false;
  }

  run(ctx: InputCtx): void {
    const { content, hits } = redact(ctx.text);
    if (hits.length === 0) return;
    ctx.text = content;
    for (const hit of hits) {
      ctx.warnings.push({
        stage: this.name,
        message: `Redacted ${hit.count}× ${hit.rule}`,
      });
    }
  }
}
