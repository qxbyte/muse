/**
 * expand-image-placeholder:把 `[Image #N]` 占位符还原为 ImagePart attachment。
 *
 * 由 BgTextInput 的 onPasteImage 写入 image registry(in-memory),输入框只显示
 * `[Image #N]` 占位符;提交时本 stage 扫占位符 → 从 registry 取 → push ImagePart
 * + 从 text 中**移除**占位符。
 *
 * 与 at-image stage 平行:at-image 走 `@<path>` 引用读盘;本 stage 走 Cmd+V 剪贴板
 * 内存中转。两者最终都产出 ImagePart attachment。
 *
 * 能力门:capabilities.supportsImages=false 时,占位符仍移除(避免污染 LLM 文本),
 * 但不 push ImagePart,加 warning。
 */

import type { PipelineStage } from "../pipeline.js";
import type { InputCtx } from "./ctx.js";

const PLACEHOLDER_RE = /\[Image #(\d+)\]/g;

export class ExpandImagePlaceholderStage implements PipelineStage<InputCtx> {
  readonly name = "expand-image-placeholder";

  constructor(
    private readonly registry: Map<number, { data: Buffer; mediaType: "image/png" }>,
  ) {}

  run(ctx: InputCtx): void {
    const matches = [...ctx.text.matchAll(PLACEHOLDER_RE)];
    if (matches.length === 0) return;

    const supportsImages = ctx.capabilities?.supportsImages ?? false;
    const seen = new Set<number>();
    const dropped: number[] = []; // 因为能力 / 缺失被丢弃,占位符要留说明文本

    for (const m of matches) {
      const id = Number(m[1]);
      if (seen.has(id)) continue;
      seen.add(id);

      const entry = this.registry.get(id);
      if (!entry) {
        ctx.warnings.push({
          stage: this.name,
          message: `[Image #${id}]: not found in registry (already consumed?)`,
        });
        dropped.push(id);
        continue;
      }

      if (!supportsImages) {
        ctx.warnings.push({
          stage: this.name,
          message: `[Image #${id}]: active model does not support images; image skipped`,
        });
        dropped.push(id);
        continue;
      }

      ctx.attachments.push({
        type: "image",
        mediaType: entry.mediaType,
        data: entry.data.toString("base64"),
        // path 借位存原占位符标签,UserMessage 渲染时直接显示这串作子项标识
        path: `[Image #${id}]`,
      });
    }

    // 成功消费的占位符**保留**在 text 里 — 让 UI 渲染时能在 user 消息里
    // 仍看到 `[Image #N]`(配合 MessageView 把 ImagePart 渲染为子项 `└ [Image #N]`),
    // 也让 LLM 知道用户在文本里 explicit 引用了哪张图。
    // 被丢弃的占位符替换为说明文本,避免"text 全空让模型自由发挥"。
    ctx.text = ctx.text
      .replace(PLACEHOLDER_RE, (full, idStr) => {
        const id = Number(idStr);
        if (!dropped.includes(id)) return full;
        return supportsImages
          ? `[image attachment unavailable]`
          : `[image attached by user, but current model does not support vision — ask the user to switch to a vision-capable model (e.g. mimo-v2.5) and resend]`;
      })
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
}

/** registry 未注入时的 noop 版本(单测 / cli runOneShot 用)。 */
export class NoopExpandImagePlaceholderStage implements PipelineStage<InputCtx> {
  readonly name = "expand-image-placeholder";
  run(): void {}
}
