/**
 * RenderPipeline 模块占位 + 渲染 helper。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.4。
 *
 * **MVP 偏离说明(ADR)**:
 * React 组件本身是声明式渲染,把 `fold-tool-use` / `highlight-diff` 强行 stage 化
 * 会引入额外抽象层(组件 ↔ stage ctx 互相转换),收益反而是负的。
 * 因此本期 RenderPipeline 仅暴露 **纯函数 helper**,供 MessageView 继续以组件方式调用;
 * 真正 stage 化推到 v0.2.x(若 stream-markdown / collapse-long / linkify 真正需要时再做)。
 *
 * 不影响整体框架——其它三段 pipeline 已统一在 Pipeline<Ctx> 之下。
 */

export { renderMarkdown } from "./markdown.js";

/** bash 工具内容里独立成行的 <stdout>/<stderr>/<timeout>/<exit_code> 包装标签剥除。 */
export function stripWrapperTags(content: string): string {
  return content
    .split("\n")
    .filter((l) => !/^<\/?(stdout|stderr|timeout|exit_code)>\s*$/.test(l.trim()))
    .join("\n");
}

/** 工具结果折叠展示:长输出取头 N 行 + "+M more lines" 提示。 */
export interface FoldedResult {
  lines: string[];
  omittedLines: number;
}

export function foldToolResult(content: string, maxLines: number): FoldedResult {
  const all = content.split("\n");
  while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
  while (all.length > 0 && all[0].trim() === "") all.shift();
  if (all.length <= maxLines) return { lines: all, omittedLines: 0 };
  return { lines: all.slice(0, maxLines), omittedLines: all.length - maxLines };
}

/** Unified diff 头几行(Index / === / --- / +++)裁掉,只保留 @@ hunks。 */
export function diffHunksOnly(diff: string): string[] {
  const lines = diff.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  return start >= 0 ? lines.slice(start) : lines;
}
