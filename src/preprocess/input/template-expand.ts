/**
 * template-expand:`{{env:VAR}}` / `{{cwd}}` / `{{date}}` 等模板插值。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.2、§九-2。
 *
 * 白名单变量,绝不暴露任意 env(避免泄露 MUSE_ACTIVE_API_KEY)。
 */

import type { PipelineStage } from "../pipeline.js";
import type { InputCtx } from "./ctx.js";

const ENV_WHITELIST = new Set(["HOME", "USER", "SHELL", "LANG"]);
const TEMPLATE_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]*)(?::([A-Z_][A-Z0-9_]*))?\}\}/g;

export class TemplateExpandStage implements PipelineStage<InputCtx> {
  readonly name = "template-expand";

  skip(ctx: InputCtx): boolean {
    return ctx.settings.templateExpand?.enabled === false;
  }

  run(ctx: InputCtx): void {
    ctx.text = ctx.text.replace(TEMPLATE_RE, (full, key: string, sub?: string) => {
      switch (key) {
        case "cwd":
          return ctx.cwd;
        case "date":
          return new Date().toISOString().slice(0, 10);
        case "env":
          if (!sub || !ENV_WHITELIST.has(sub)) {
            ctx.warnings.push({
              stage: this.name,
              message: `{{env:${sub ?? ""}}}: var not in whitelist`,
            });
            return full;
          }
          return process.env[sub] ?? "";
        default:
          return full;
      }
    });
  }
}
