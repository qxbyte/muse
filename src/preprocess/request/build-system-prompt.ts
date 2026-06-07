/**
 * build-system-prompt:复用 src/loop/system-prompt.ts 的 builder 拼装基线 system prompt。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2;模块设计/Agent 记忆系统/设计.md §4.1。
 *
 * 顺序:基础 prompt → hierarchy(MUSE.md / AGENTS.md)→ extraSystemPrompt(SessionStart hook)
 * 后续 stage(inject-memory / inject-todos)继续追加。
 */

import type { PipelineStage } from "../pipeline.js";
import { buildSystemPrompt } from "../../loop/system-prompt.js";
import { formatHierarchyForPrompt } from "../../loop/hierarchy.js";
import type { RequestCtx } from "./ctx.js";

export class BuildSystemPromptStage implements PipelineStage<RequestCtx> {
  readonly name = "build-system-prompt";

  run(ctx: RequestCtx): void {
    // memoryIndex 留给 inject-memory stage 单独注入,这里不重复拼。
    // toolNames 取全集(plan 模式过滤推迟到 apply-mode-filter,system prompt 文案
    // 里展示工具仍按全集 — 让 LLM 在 plan 模式也知道有哪些工具可"将来"用)。
    ctx.systemPrompt = buildSystemPrompt({
      cwd: ctx.cwd,
      model: ctx.modelId,
      provider: ctx.services.provider,
      lang: ctx.services.lang,
      toolNames: ctx.services.toolRegistry.list().map((t) => t.name),
    });
    // II-1:hierarchy(MUSE.md / AGENTS.md / local / managed)拼进稳定 prefix 段
    const hierarchyText = formatHierarchyForPrompt(ctx.services.hierarchy ?? []);
    if (hierarchyText) {
      ctx.systemPrompt = `${ctx.systemPrompt}\n\n${hierarchyText}`;
    }
    // SessionStart hook 注入的额外 system prompt(若有)。
    if (ctx.services.extraSystemPrompt) {
      ctx.systemPrompt = `${ctx.systemPrompt}\n\n${ctx.services.extraSystemPrompt}`;
    }
  }
}
