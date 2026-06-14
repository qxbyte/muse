/**
 * InputPipeline 装配。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1。
 *
 * Stage 顺序:slash-dispatch → paste-expand → at-file-expand → template-expand →
 *           validate-length → redact-pre-scan
 *
 * 注意:slash-dispatch 命中后立即 PipelineShortCircuit,后续 stage 不执行;
 *      caller 检查 ctx.slashCommand 决定路由到 SlashRegistry 还是 Agent。
 */

import { Pipeline, type PipelineRunOptions } from "../pipeline.js";
import { SlashDispatchStage } from "./slash-dispatch.js";
import { PasteExpandStage, NoopPasteExpandStage } from "./paste-expand.js";
import { AtSkillExpandStage } from "./at-skill-expand.js";
import { AtFileExpandStage } from "./at-file-expand.js";
import { AtImageStage } from "./at-image.js";
import { ExpandImagePlaceholderStage, NoopExpandImagePlaceholderStage } from "./expand-image-placeholder.js";
import { TemplateExpandStage } from "./template-expand.js";
import { ValidateLengthStage } from "./validate-length.js";
import { RedactPreScanStage } from "./redact-pre-scan.js";
import type { InputCtx } from "./ctx.js";
import type { ContentPart } from "../../types/index.js";

export type { InputCtx, InputAttachment, InputWarning, InputSlashCommand, InputPreprocessSettings, InputCapabilities } from "./ctx.js";
export { createInputCtx } from "./ctx.js";

/**
 * 把 InputCtx 输出组装为 Agent.runTurn 接受的 user content。
 *
 *   - 无 attachment → 返 string(向后兼容,session 历史可读性更好)
 *   - 有 attachment → 返 ContentPart[](TextPart + FilePart/ImagePart...)
 *
 * text 始终作为第一个 part(用户的纯指令);attachments 按 push 顺序追加。
 */
export function buildUserMessage(ctx: InputCtx): string | ContentPart[] {
  if (ctx.attachments.length === 0) return ctx.text;
  const parts: ContentPart[] = [{ type: "text", text: ctx.text }];
  for (const att of ctx.attachments) parts.push(att);
  return parts;
}

export interface InputPipelineOpts extends PipelineRunOptions {
  /** Paste registry(BgTextInput 持有);为空则跳过 paste-expand。 */
  pasteRegistry?: Map<number, string>;
  /** Image registry(BgTextInput 持有);为空则跳过 expand-image-placeholder。 */
  imageRegistry?: Map<number, { data: Buffer; mediaType: "image/png" }>;
}

export function InputPipeline(opts: InputPipelineOpts = {}): Pipeline<InputCtx> {
  const pasteStage = opts.pasteRegistry
    ? new PasteExpandStage(opts.pasteRegistry)
    : new NoopPasteExpandStage();
  const imageStage = opts.imageRegistry
    ? new ExpandImagePlaceholderStage(opts.imageRegistry)
    : new NoopExpandImagePlaceholderStage();
  return new Pipeline<InputCtx>(
    [
      new SlashDispatchStage(),
      pasteStage,
      imageStage,
      new AtSkillExpandStage(),
      new AtFileExpandStage(),
      new AtImageStage(),
      new TemplateExpandStage(),
      new ValidateLengthStage(),
      new RedactPreScanStage(),
    ],
    { ...opts, pipelineName: "input" },
  );
}
