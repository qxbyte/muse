/**
 * 文件改动 → unified diff（jsdiff），仅给 UI 渲染用，不进 LLM 上下文。
 *
 * 上下文行数 3（GNU diff 默认）；新文件 / 整体覆盖时呈现为全 + 行。
 */

import { createPatch } from "diff";

const MAX_DIFF_LINES = 200;

export function makeUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "";
  const patch = createPatch(filePath, oldContent, newContent, "before", "after", { context: 3 });
  return truncate(patch);
}

function truncate(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return diff;
  return lines.slice(0, MAX_DIFF_LINES).join("\n") + `\n... [${lines.length - MAX_DIFF_LINES} more diff lines truncated]`;
}
