/**
 * at-image:识别 `@<path>` 中的图片引用(.png/.jpg/.jpeg/.gif/.webp),读 buffer→base64→push ImagePart。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2。
 *
 * 与 at-file-expand 平行:
 *   - at-file-expand 跳过图片扩展名(只处理文本)
 *   - at-image      只处理图片扩展名(读为 base64)
 *
 * 能力门:ctx.capabilities.supportsImages === false 时,识别但丢弃 + warning,
 * 不读 buffer(节省 IO + 不让大图浪费内存)。
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { PipelineStage } from "../pipeline.js";
import { checkSensitivePath } from "../../tools/_sensitive.js";
import type { InputCtx } from "./ctx.js";

const AT_PATTERN = /(?:^|\s)@((?:\/|\.\/|~\/)[^\s]+|[A-Za-z0-9_.\-/]+)/g;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class AtImageStage implements PipelineStage<InputCtx> {
  readonly name = "at-image";

  skip(ctx: InputCtx): boolean {
    return ctx.settings.atImage?.enabled === false;
  }

  async run(ctx: InputCtx): Promise<void> {
    const refs = collectRefs(ctx.text);
    if (refs.length === 0) return;

    const maxBytes = ctx.settings.atImage?.maxBytes ?? DEFAULT_MAX_BYTES;
    const supportsImages = ctx.capabilities?.supportsImages ?? false;
    const seen = new Set<string>();

    for (const ref of refs) {
      const abs = toAbsolute(ref, ctx.cwd);
      if (seen.has(abs)) continue;

      const ext = extname(abs).toLowerCase();
      const mediaType = IMAGE_EXTS[ext];
      if (!mediaType) continue; // 非图片,留给 at-file-expand 处理

      seen.add(abs);

      // 能力门:active model 不支持图片 → 直接 warning,不读 buffer
      if (!supportsImages) {
        ctx.warnings.push({
          stage: this.name,
          message: `@${basename(abs)}: active model does not support images; image skipped`,
        });
        continue;
      }

      const sensitive = checkSensitivePath(abs);
      if (sensitive.blocked) {
        ctx.warnings.push({
          stage: this.name,
          message: `Skipped @${ref}: ${sensitive.reason}`,
        });
        continue;
      }

      try {
        const info = await stat(abs);
        if (!info.isFile()) {
          ctx.warnings.push({ stage: this.name, message: `@${ref}: not a regular file` });
          continue;
        }
        if (info.size > maxBytes) {
          ctx.warnings.push({
            stage: this.name,
            message: `@${ref}: image too large (${info.size} bytes > ${maxBytes})`,
          });
          continue;
        }
        const buf = await readFile(abs);
        ctx.attachments.push({
          type: "image",
          mediaType,
          data: buf.toString("base64"),
          path: abs,
        });
      } catch (err) {
        ctx.warnings.push({
          stage: this.name,
          message: `@${ref}: ${(err as Error).message}`,
        });
      }
    }
  }
}

function collectRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(AT_PATTERN)) {
    out.push(m[1]);
  }
  return out;
}

function toAbsolute(ref: string, cwd: string): string {
  if (ref.startsWith("~/")) {
    return resolve(process.env.HOME ?? "", ref.slice(2));
  }
  if (isAbsolute(ref)) return ref;
  return resolve(cwd, ref.replace(/^\.\//, ""));
}
