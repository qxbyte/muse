/**
 * paste-expand:把 `[Pasted text #N +M lines]` 占位符还原为原文。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2。
 *
 * paste registry 由 BgTextInput 持有(用 ref);本 stage 通过构造函数注入。
 */

import type { PipelineStage } from "../pipeline.js";
import type { InputCtx } from "./ctx.js";

const PASTE_PLACEHOLDER_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

export class PasteExpandStage implements PipelineStage<InputCtx> {
  readonly name = "paste-expand";

  constructor(private readonly registry: Map<number, string>) {}

  run(ctx: InputCtx): void {
    ctx.text = ctx.text.replace(PASTE_PLACEHOLDER_RE, (full, id) => {
      const text = this.registry.get(Number(id));
      return text ?? full;
    });
  }
}

/** 不接 paste registry 时的 noop 版本(单次 CLI / 单测用)。 */
export class NoopPasteExpandStage implements PipelineStage<InputCtx> {
  readonly name = "paste-expand";
  run(): void {}
}
