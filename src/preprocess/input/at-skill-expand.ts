/**
 * at-skill-expand:识别 `@<skill-name>` 引用 → 记录待激活 skill,并剥掉 `@`。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7 / §十(v0.3.x @skill mention)。
 *
 * 行为(已与用户确认):`@<skill>` = 显式激活该 skill(等价 `/skill run`,绕过 LLM 自决)。
 *
 * 必须排在 at-file-expand **之前**:skill 名(kebab/snake,无 `/`)会被 at-file 的
 * `@<path>` 正则当成相对路径文件去读 → ENOENT 告警。本 stage 先把命中 skill 名的
 * `@<skill>` 的 `@` 剥掉(留 `skill-name` 作自然文本 + LLM 上下文),at-file 就不再匹配。
 *
 * 本 stage 只**检测 + 记录**到 ctx.skillActivations;真正激活(改 agent skillState +
 * PermissionGate 临时白名单)由 caller(app.tsx)在 pipeline 跑完后执行 —— stage 层
 * 不持 agent 运行期状态。
 */

import type { PipelineStage } from "../pipeline.js";
import type { InputCtx } from "./ctx.js";

// skill 名字符集对齐 SkillFrontmatterSchema:/^[a-z0-9][a-z0-9-_]*$/
const AT_SKILL_PATTERN = /(^|\s)@([a-z0-9][a-z0-9_-]*)/g;

export class AtSkillExpandStage implements PipelineStage<InputCtx> {
  readonly name = "at-skill-expand";

  skip(ctx: InputCtx): boolean {
    return !ctx.skillNames || ctx.skillNames.length === 0;
  }

  run(ctx: InputCtx): void {
    const skillSet = new Set(ctx.skillNames);
    const found = new Set<string>();
    ctx.text = ctx.text.replace(AT_SKILL_PATTERN, (full, pre: string, name: string) => {
      if (skillSet.has(name)) {
        found.add(name);
        return `${pre}${name}`; // 剥掉 @,保留 skill 名作自然文本
      }
      return full;
    });
    for (const name of found) ctx.skillActivations.push(name);
  }
}
