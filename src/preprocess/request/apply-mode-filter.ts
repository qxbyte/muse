/**
 * apply-mode-filter:plan 模式过滤工具列表为 read-only,并把 mode 提示拼入 system prompt。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2。
 *
 * 原逻辑在 agent.ts L77-80,搬到 stage,行为不变。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";

export class ApplyModeFilterStage implements PipelineStage<RequestCtx> {
  readonly name = "apply-mode-filter";

  run(ctx: RequestCtx): void {
    const filter = ctx.mode === "plan" ? (t: { permission: string }) => t.permission === "read" : undefined;
    ctx.tools = ctx.services.toolRegistry.toLLMDefinitions(filter);

    if (ctx.mode === "plan") {
      const note = `# Plan mode\nYou are in plan mode. Only read-only tools are visible. Propose changes to the user; do not call write/execute tools.`;
      ctx.systemPrompt = ctx.systemPrompt
        ? `${ctx.systemPrompt}\n\n${note}`
        : note;
    }
  }
}
