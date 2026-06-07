/**
 * at-file-expand:识别 `@<path>` 引用,读文件内容塞 attachments 作 FilePart;
 * 路径白名单过滤。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2。
 *
 * 协议层升级(2026-06-06):
 *   - 旧:wrap `<file path="...">…</file>` XML 拼到 ctx.text 末尾
 *   - 新:仅 push FilePart 到 ctx.attachments;ctx.text 保留 `@<path>` 引用(供 LLM 上下文)
 *
 * 下游(buildUserMessage)负责把 attachments 与 text 组装成 ContentPart[];
 * LLM client 序列化时按 provider 能力决定 file part native 还是退化为 wrap text。
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, extname } from "node:path";
import type { PipelineStage } from "../pipeline.js";
import { checkSensitivePath } from "../../tools/_sensitive.js";
import type { InputCtx } from "./ctx.js";

const AT_PATTERN = /(?:^|\s)@((?:\/|\.\/|~\/)[^\s]+|[A-Za-z0-9_.\-/]+)/g;
const DEFAULT_MAX_BYTES = 64 * 1024;
// 图片由后续 at-image stage(Phase B)处理,这里跳过,避免按文本读坏。
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export class AtFileExpandStage implements PipelineStage<InputCtx> {
  readonly name = "at-file-expand";

  skip(ctx: InputCtx): boolean {
    return ctx.settings.atFileExpand?.enabled === false;
  }

  async run(ctx: InputCtx): Promise<void> {
    const maxBytes = ctx.settings.atFileExpand?.maxBytes ?? DEFAULT_MAX_BYTES;
    const refs = collectRefs(ctx.text);
    if (refs.length === 0) return;

    const seen = new Set<string>();
    for (const ref of refs) {
      const abs = toAbsolute(ref, ctx.cwd);
      if (seen.has(abs)) continue;
      seen.add(abs);

      // 图片走 Phase B 的 at-image stage,这里不动
      if (IMAGE_EXTS.has(extname(abs).toLowerCase())) continue;

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
            message: `@${ref}: file too large (${info.size} bytes > ${maxBytes})`,
          });
          continue;
        }
        const body = await readFile(abs, "utf-8");
        ctx.attachments.push({
          type: "file",
          path: abs,
          mimeType: guessMimeType(abs),
          text: body,
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

/** 粗略 mime,不强约束;主要给 LLM 一个语义提示。 */
function guessMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".ts": case ".tsx": return "text/x-typescript";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "text/javascript";
    case ".py": return "text/x-python";
    case ".go": return "text/x-go";
    case ".rs": return "text/x-rust";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".yaml": case ".yml": return "text/yaml";
    case ".toml": return "text/toml";
    case ".html": case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".sh": case ".bash": case ".zsh": return "text/x-shellscript";
    case ".sql": return "text/x-sql";
    case ".xml": return "text/xml";
    default: return "text/plain";
  }
}
