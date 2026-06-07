/**
 * apply-mode-filter:plan 模式过滤工具列表为 read-only,并把 mode 提示拼入 system prompt。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.2.2。
 *
 * 原逻辑在 agent.ts L77-80,搬到 stage,行为不变。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";

export class ApplyModeFilterStage implements PipelineStage<RequestCtx> {
  readonly name = "apply-mode-filter";

  run(ctx: RequestCtx): void {
    // I-5:Memory 工具永远可见(plan 模式下也保留)— Anthropic cookbook 强制
    // exclude_tools:["memory"] 反义,对齐"压缩时不丢记忆"原则;memory 写入不算"执行性写代码",
    // 不违反 plan 模式语义。
    const MEMORY_WHITELIST = new Set(["MemoryRead", "MemoryWrite"]);
    const filter =
      ctx.mode === "plan"
        ? (t: { name: string; permission: string }) =>
            t.permission === "read" || MEMORY_WHITELIST.has(t.name)
        : undefined;
    ctx.tools = ctx.services.toolRegistry.toLLMDefinitions(filter);

    if (ctx.mode === "plan") {
      // 显式列出可用工具名 + 明令"忽略历史里 write tool 的例子"。
      // 没有 enumeration 时 mimo / qwen 等国内模型容易因为历史里有 Edit/Bash 调用而
      // 模仿,触发 provider server 端 "unavailable tool" 拒绝(用户看到一条无关
      // 的 server error,体验差)。把白名单 inline 写死能显著降低这种 false call。
      const allowedNames = ctx.tools.map((t) => t.name).join(", ");
      const note =
        `# Plan mode (active)\n` +
        `You are in PLAN mode. Read and analyze, then propose changes in your text answer — do not execute them.\n\n` +
        `Allowed tools this turn: **${allowedNames}**.\n\n` +
        `⚠ HARD RULES:\n` +
        `1. Do NOT call any tool not in the allowed list (e.g. Edit, Write, Bash, MemoryWrite, WebFetch).\n` +
        `2. Earlier turns may contain successful write-tool calls (Edit / Write / Bash etc.) — those examples DO NOT apply now. Ignore them.\n` +
        `3. If the user's request requires writing, reply with a plan and ask them to switch out of plan mode to apply it.`;
      ctx.systemPrompt = ctx.systemPrompt
        ? `${ctx.systemPrompt}\n\n${note}`
        : note;
    }
  }
}
