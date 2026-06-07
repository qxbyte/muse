/**
 * RequestPipeline 装配。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2。
 *
 * Stage 顺序:
 *   build-system-prompt → inject-memory → inject-todos → apply-mode-filter
 *   → trim-history → budget-guard
 *
 * trim-history / budget-guard 排最末:前面所有 stage 注入的内容(memory/todos/
 * tools schema)都参与 token 估算后再决定是否裁/压缩。
 *
 * redact 留 v0.2.x(P2,设计文档 §八)。
 */

import { Pipeline, type PipelineRunOptions } from "../pipeline.js";
import { BuildSystemPromptStage } from "./build-system-prompt.js";
import { InjectMemoryStage } from "./inject-memory.js";
import { InjectTodosStage } from "./inject-todos.js";
import { ApplyModeFilterStage } from "./apply-mode-filter.js";
import { ClearStaleToolResultsStage } from "./clear-stale-tool-results.js";
import { TrimHistoryStage } from "./trim-history.js";
import { BudgetGuardStage } from "./budget-guard.js";
import type { RequestCtx } from "./ctx.js";

export type { RequestCtx, RequestServices, RequestPreprocessSettings } from "./ctx.js";
export { createRequestCtx } from "./ctx.js";
export { BudgetExceededError } from "./budget-guard.js";

export function RequestPipeline(opts: PipelineRunOptions = {}): Pipeline<RequestCtx> {
  return new Pipeline<RequestCtx>(
    [
      new BuildSystemPromptStage(),
      new InjectMemoryStage(),
      new ClearStaleToolResultsStage(),  // I-3:折叠可重获取的旧 tool result(在 trim/budget 之前)
      new InjectTodosStage(),
      new ApplyModeFilterStage(),
      new TrimHistoryStage(),
      new BudgetGuardStage(),
    ],
    { ...opts, pipelineName: "request" },
  );
}
