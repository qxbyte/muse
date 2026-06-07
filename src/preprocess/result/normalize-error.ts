/**
 * normalize-error:把工具错误归一为 { kind, message },内容顶部加一行 [error: <kind>] <message>。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2、§5.3。
 *
 * 不丢弃原文,只前置一行提示,让 LLM 用稳定格式决策。
 */

import type { PipelineStage } from "../pipeline.js";
import type { ResultCtx, NormalizedError, NormalizedErrorKind } from "./ctx.js";

export class NormalizeErrorStage implements PipelineStage<ResultCtx> {
  readonly name = "normalize-error";

  skip(ctx: ResultCtx): boolean {
    if (ctx.settings.normalizeError?.enabled === false) return true;
    return !ctx.raw.isError;
  }

  run(ctx: ResultCtx): void {
    const kind = classifyError(ctx.content);
    const firstLine = ctx.content.split("\n").find((l) => l.trim().length > 0) ?? "(no message)";
    const message = firstLine.replace(/^Refused:\s*/i, "").slice(0, 200);
    const normalized: NormalizedError = { kind, message, raw: ctx.content };
    ctx.normalizedError = normalized;
    const prefix = `[error: ${kind}] ${message}`;
    if (!ctx.content.startsWith(prefix)) {
      ctx.content = `${prefix}\n${ctx.content}`;
    }
  }
}

function classifyError(text: string): NormalizedErrorKind {
  const lower = text.toLowerCase();
  if (/permission|denied|refused|forbidden|sensitive/.test(lower)) return "permission";
  if (/timeout|timed out|deadline/.test(lower)) return "timeout";
  if (/not found|enoent|no such file/.test(lower)) return "not_found";
  if (/ssrf|network|fetch failed|enotfound|econnrefused/.test(lower)) return "network";
  if (/binary|nul byte/.test(lower)) return "binary";
  return "unknown";
}
