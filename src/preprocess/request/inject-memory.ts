/**
 * inject-memory:把 MEMORY.md 索引内容拼到 system prompt 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2。
 *
 * services.memoryIndex 由 caller(app/cli)在 turn 前一次性加载,这里只拼装。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";

export class InjectMemoryStage implements PipelineStage<RequestCtx> {
  readonly name = "inject-memory";

  run(ctx: RequestCtx): void {
    const index = ctx.services.memoryIndex?.trim();
    if (!index) return;
    const section =
      `# Memory (long-term)\n` +
      `Below is MEMORY.md — your index of persistent facts about the user, project, and prior feedback. ` +
      `Each line points at a file you can MemoryRead. Use MemoryWrite to record new durable knowledge ` +
      `(user role/preferences, validated decisions, project facts, external references). Do NOT save things ` +
      `derivable from the repo or git history.\n\n` +
      index;
    ctx.systemPrompt = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${section}`
      : section;
  }
}
