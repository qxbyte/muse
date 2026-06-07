/**
 * slash-dispatch:识别 `/cmd args`,命中后短路 pipeline,交给 SlashRegistry。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2。
 */

import type { PipelineStage } from "../pipeline.js";
import { PipelineShortCircuit } from "../pipeline.js";
import { parseSlash } from "../../slash/registry.js";
import type { InputCtx } from "./ctx.js";

export class SlashDispatchStage implements PipelineStage<InputCtx> {
  readonly name = "slash-dispatch";
  run(ctx: InputCtx): void {
    const parsed = parseSlash(ctx.text);
    if (!parsed) return;
    ctx.slashCommand = { name: parsed.name, args: parsed.args };
    throw new PipelineShortCircuit(`slash:/${parsed.name}`);
  }
}
