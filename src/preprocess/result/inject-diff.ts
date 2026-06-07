/**
 * inject-diff:把 Edit/Write 等工具的 diff 拼到回灌给 LLM 的 content 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2。
 *
 * 默认关闭:diff 仅进 UI(ctx.diff 字段不被消费到 content);开启时让 LLM
 * 看见自己改了什么,便于自检 / 下一步推理。
 */

import type { PipelineStage } from "../pipeline.js";
import { diffHunksOnly } from "../render/index.js";
import type { ResultCtx } from "./ctx.js";

export class InjectDiffStage implements PipelineStage<ResultCtx> {
  readonly name = "inject-diff";

  skip(ctx: ResultCtx): boolean {
    if (ctx.settings.injectDiff !== true) return true;
    return !ctx.diff;
  }

  run(ctx: ResultCtx): void {
    if (!ctx.diff) return;
    const hunks = diffHunksOnly(ctx.diff).join("\n");
    ctx.content = `${ctx.content}\n\n--- diff ---\n${hunks}`;
  }
}
