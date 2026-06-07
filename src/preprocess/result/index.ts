/**
 * ResultPipeline 装配。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3。
 *
 * Stage 顺序:
 *   detect-binary → truncate → summarize → normalize-error → redact → inject-diff
 *
 * - redact 默认开(2026-06-06 Phase 2 加入)
 * - inject-diff 默认关
 */

import { Pipeline, type PipelineRunOptions } from "../pipeline.js";
import { DetectBinaryStage } from "./detect-binary.js";
import { TruncateStage } from "./truncate.js";
import { SummarizeStage } from "./summarize.js";
import { NormalizeErrorStage } from "./normalize-error.js";
import { RedactResultStage } from "./redact.js";
import { InjectDiffStage } from "./inject-diff.js";
import type { ResultCtx } from "./ctx.js";

export type { ResultCtx, ResultPreprocessSettings, NormalizedError, NormalizedErrorKind } from "./ctx.js";
export { createResultCtx } from "./ctx.js";

export function ResultPipeline(opts: PipelineRunOptions = {}): Pipeline<ResultCtx> {
  return new Pipeline<ResultCtx>(
    [
      new DetectBinaryStage(),
      new TruncateStage(),
      new SummarizeStage(),
      new NormalizeErrorStage(),
      new RedactResultStage(),
      new InjectDiffStage(),
    ],
    { ...opts, pipelineName: "result" },
  );
}
