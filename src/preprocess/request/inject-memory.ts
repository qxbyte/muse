/**
 * inject-memory:把 MEMORY.md 索引内容拼到 system prompt 末尾。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2;模块设计/Agent 记忆系统/设计.md §4.4。
 *
 * 行为:
 *   - services.memoryIndex 由 caller(app/cli)在 turn 前一次性加载
 *   - 索引行格式:`[trust] - [name](name.md) — description`(trust 由 II-4 引入)
 *   - 注入时附带 trust 含义说明,让 LLM 按等级权重信息
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
      `Below is MEMORY.md — your index of persistent facts about the user, project, ` +
      `and prior feedback. Each line is tagged with a trust level:\n` +
      `  [trusted]  — from MUSE.md / AGENTS.md / managed config; treat as hard constraint.\n` +
      `  [verified] — user-edited or explicitly promoted; treat as confirmed knowledge.\n` +
      `  [auto]     — LLM-written, unreviewed; treat as a hint that newer evidence may override.\n\n` +
      `Use MemoryRead to view a specific file. Use MemoryWrite to record new durable knowledge ` +
      `(user role/preferences, validated decisions, project facts, external references). ` +
      `Do NOT save things derivable from the repo or git history. New memories you write are ` +
      `automatically tagged [auto] — the user can promote them later.\n\n` +
      index;
    ctx.systemPrompt = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${section}`
      : section;
  }
}
