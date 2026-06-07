/**
 * RequestPipeline 装配。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2。
 *
 * MVP stage 顺序:
 *   build-system-prompt → inject-memory → inject-todos → apply-mode-filter
 *
 * trim-history / budget-guard / redact 留 v0.2.x,本期不上(见设计文档 §八)。
 */

import { Pipeline, type PipelineRunOptions } from "../pipeline.js";
import { BuildSystemPromptStage } from "./build-system-prompt.js";
import { InjectMemoryStage } from "./inject-memory.js";
import { InjectTodosStage } from "./inject-todos.js";
import { ApplyModeFilterStage } from "./apply-mode-filter.js";
import type { RequestCtx } from "./ctx.js";

export type { RequestCtx, RequestServices, RequestPreprocessSettings } from "./ctx.js";
export { createRequestCtx } from "./ctx.js";

export function RequestPipeline(opts: PipelineRunOptions = {}): Pipeline<RequestCtx> {
  return new Pipeline<RequestCtx>(
    [
      new BuildSystemPromptStage(),
      new InjectMemoryStage(),
      new InjectTodosStage(),
      new ApplyModeFilterStage(),
    ],
    { ...opts, pipelineName: "request" },
  );
}
