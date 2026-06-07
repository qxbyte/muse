/**
 * summarize:给长结果加一行 summary(规则化,不调 LLM)。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2。
 *
 * 规则:
 *   - Bash: 抽 exit code(已被 normalize-error / 工具内部填,可能已有 summary)
 *   - Read: 行数
 *   - Grep: 匹配数
 *   - WebFetch: title(粗略)
 *
 * 仅在 ctx.summary 为空时填。
 */

import type { PipelineStage } from "../pipeline.js";
import type { ResultCtx } from "./ctx.js";

export class SummarizeStage implements PipelineStage<ResultCtx> {
  readonly name = "summarize";

  skip(ctx: ResultCtx): boolean {
    if (ctx.settings.summarize?.enabled === false) return true;
    return !!ctx.summary;
  }

  run(ctx: ResultCtx): void {
    const lines = ctx.content.split("\n");
    switch (ctx.toolName) {
      case "Read": {
        const content = lines.length > 0 ? lines.length : 0;
        ctx.summary = `Read ${content} lines`;
        break;
      }
      case "Grep": {
        // 粗略:非空行计为 match
        const matches = lines.filter((l) => l.trim().length > 0).length;
        ctx.summary = `Grep ${matches} match${matches === 1 ? "" : "es"}`;
        break;
      }
      case "Bash": {
        ctx.summary = ctx.raw.isError ? `Bash failed` : `Bash ok`;
        break;
      }
      case "WebFetch": {
        const titleLine = lines.find((l) => /^#\s/.test(l));
        ctx.summary = titleLine ? titleLine.replace(/^#\s*/, "").slice(0, 80) : `WebFetch ${lines.length} lines`;
        break;
      }
      case "Glob": {
        const files = lines.filter((l) => l.trim().length > 0).length;
        ctx.summary = `Glob ${files} file${files === 1 ? "" : "s"}`;
        break;
      }
      default:
        if (lines.length > 1) ctx.summary = `${ctx.toolName}: ${lines.length} lines`;
    }
  }
}
