/**
 * redact (ResultPipeline):扫工具结果 content 中的 secret pattern。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2、§5.2。
 *
 * 默认开启:bash / read / webfetch 等工具的输出极易含密钥(.env、git diff
 * 误带 PEM、API 错误响应里回显的 token 等)。LLM 直接看到这些字符比 user
 * 误粘进输入还危险,因为它会原样 echo 进对话历史。
 */

import type { PipelineStage } from "../pipeline.js";
import { redact } from "../redact.js";
import type { ResultCtx } from "./ctx.js";

export class RedactResultStage implements PipelineStage<ResultCtx> {
  readonly name = "redact";

  skip(ctx: ResultCtx): boolean {
    if (ctx.settings.redact?.enabled === false) return true;
    return ctx.binaryDetected != null;
  }

  run(ctx: ResultCtx): void {
    const { content, hits } = redact(ctx.content);
    if (hits.length === 0) return;
    ctx.content = content;
    const labels = hits.map((h) => `${h.count}× ${h.rule}`).join(", ");
    ctx.warnings.push({ stage: this.name, message: `Redacted ${labels}` });
    // 在 summary 上加 [contains redacted] 提示
    if (ctx.summary) {
      if (!ctx.summary.includes("[contains redacted]")) {
        ctx.summary = `${ctx.summary} [contains redacted]`;
      }
    } else {
      ctx.summary = `[contains redacted: ${labels}]`;
    }
  }
}
