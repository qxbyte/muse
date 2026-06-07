/**
 * inject-todos:把当前 todos 拼到 system prompt 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2。
 *
 * 原逻辑在 agent.ts L82-85,搬到 stage,行为不变。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";

export class InjectTodosStage implements PipelineStage<RequestCtx> {
  readonly name = "inject-todos";

  run(ctx: RequestCtx): void {
    const section = ctx.services.todos.toPromptSection();
    if (!section) return;
    ctx.systemPrompt = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${section}`
      : section;
  }
}
