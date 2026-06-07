/**
 * clear-stale-tool-results stage:折叠"可重新获取"的旧 tool result。
 *
 * 设计文档:模块设计/上下文管理工程/设计.md §4.3。
 *
 * 思路:
 *   - Read / Grep / Glob 类工具是"可重新获取"的 — 同一文件 / 同一查询出现多次时,
 *     只保留最新一次的结果原文,旧的折叠成 placeholder
 *   - Bash / Edit / Write / MemoryWrite / WebFetch 等有副作用或不可重获,绝不清
 *
 * 安全保护:
 *   1. 最近 K 轮(默认 3)不清:刚跑完的可能正被 assistant 引用
 *   2. 一条 Read 后若有同文件 Edit/Write,该 Read 保留(Edit 依赖"必须先 Read")
 *   3. 配对完整性:只改 tool result.content,不删 message,保 tool_use ↔ tool_result 关系
 *   4. 保留 summary 字段(ResultPipeline.summarize 生成),只清原文 content
 *
 * 不污染 agent.messages:就地修改 ctx.messages 数组里的 tool message content,
 * 不替换 message 引用(因为 message 在 Agent 持有的 messages 数组里共享 — 改 content
 * 会让 Agent 看到清理后的版本)。
 *
 * 实际上:为了真正不污染 Agent 真值,这里创建**新的 ToolMessage 对象**(浅 copy + content 覆盖),
 * 替换 ctx.messages 数组里的引用。Agent 通过 services.compact 之外的路径不会污染。
 */

import type { PipelineStage } from "../pipeline.js";
import type { RequestCtx } from "./ctx.js";
import type { Message, ToolMessage, AssistantMessage } from "../../types/index.js";

const DEFAULT_CLEAR_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
const DEFAULT_KEEP_RECENT_TURNS = 3;

export interface ClearStaleToolResultsSettings {
  enabled?: boolean;
  keepRecentTurns?: number;
  clearTools?: string[];
}

export class ClearStaleToolResultsStage implements PipelineStage<RequestCtx> {
  readonly name = "clear-stale-tool-results";

  skip(ctx: RequestCtx): boolean {
    return ctx.settings.clearStaleToolResults?.enabled === false;
  }

  run(ctx: RequestCtx): void {
    const settings = ctx.settings.clearStaleToolResults;
    const keepRecent = settings?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
    const clearTools = new Set(settings?.clearTools ?? DEFAULT_CLEAR_TOOLS);
    ctx.messages = clearStaleResults(ctx.messages, keepRecent, clearTools);
  }
}

/**
 * 核心算法(导出便于测试):
 *   1. 扫描 messages 数组,建立 toolUseId → ToolUsePart 映射 + recordIdx 索引
 *   2. 对每条 tool message,按 (name, normalizedArgs) 分组
 *   3. 同组中保留 lastOccurrence(最大 idx);其他 occurrences 标记 stale
 *   4. 同时检测"被该 Read 之后是否有同文件的 Edit/Write"→ 是则该 Read 不清
 *   5. 最近 keepRecentTurns 条 tool message 不清(无论是否 stale)
 *   6. 替换 stale 的 tool message content 为 placeholder,保留 summary
 */
export function clearStaleResults(
  messages: Message[],
  keepRecentTurns: number,
  clearTools: Set<string>,
): Message[] {
  // 1. 建索引:toolUseId → { name, args, msgIdx }
  const toolUseIndex = new Map<string, { name: string; args: unknown; assistantIdx: number }>();
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      const am = m as AssistantMessage;
      for (const p of am.content) {
        if (p.type === "tool_use") {
          toolUseIndex.set(p.id, { name: p.name, args: p.args, assistantIdx: i });
        }
      }
    }
  });

  // 2. 收集 tool messages 的位置 + 关联 tool_use 信息
  interface ToolEntry {
    msgIdx: number;
    toolUseId: string;
    name: string;
    args: unknown;
    key: string;
  }
  const toolEntries: ToolEntry[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      const tm = m as ToolMessage;
      const info = toolUseIndex.get(tm.toolUseId);
      if (!info) return; // 悬挂 tool;不动它(理论上不应该出现)
      if (!clearTools.has(info.name)) return; // 不在可清白名单
      const key = `${info.name}::${normalizeArgs(info.args)}`;
      toolEntries.push({ msgIdx: i, toolUseId: tm.toolUseId, name: info.name, args: info.args, key });
    }
  });

  if (toolEntries.length === 0) return messages;

  // 3. 按 key 分组,留 lastOccurrence
  const lastOccByKey = new Map<string, number>(); // key → msgIdx
  for (const e of toolEntries) {
    const prev = lastOccByKey.get(e.key) ?? -1;
    if (e.msgIdx > prev) lastOccByKey.set(e.key, e.msgIdx);
  }

  // 4. 检测被保护的 Read(后续有 Edit/Write 同文件)
  // 提 path 的逻辑只对 Read 类适用(args.file_path);Grep/Glob 没有"修改"概念,跳过保护检查
  const protectedReads = new Set<number>(); // msgIdx 集合
  for (const e of toolEntries) {
    if (e.name !== "Read") continue;
    const readPath = extractPath(e.args);
    if (!readPath) continue;
    // 在 e.msgIdx 之后找 Edit/Write 操作同路径
    for (let i = e.msgIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const am = m as AssistantMessage;
      for (const p of am.content) {
        if (p.type === "tool_use" && (p.name === "Edit" || p.name === "Write")) {
          const editPath = extractPath(p.args);
          if (editPath === readPath) {
            protectedReads.add(e.msgIdx);
            break;
          }
        }
      }
      if (protectedReads.has(e.msgIdx)) break;
    }
  }

  // 5. 最近 K 条 tool message 全保(无论 stale)
  const allToolIndices = toolEntries.map((e) => e.msgIdx);
  const recentCutoff =
    allToolIndices.length > keepRecentTurns
      ? allToolIndices[allToolIndices.length - keepRecentTurns]
      : -1;

  // 6. 决定哪些 stale 要清
  const indicesToClear = new Set<number>();
  for (const e of toolEntries) {
    // 不在最新一次 → stale
    if (lastOccByKey.get(e.key) === e.msgIdx) continue;
    // 在最近 K 轮内 → 保
    if (e.msgIdx >= recentCutoff) continue;
    // 被 Edit/Write 保护 → 保
    if (protectedReads.has(e.msgIdx)) continue;
    indicesToClear.add(e.msgIdx);
  }

  if (indicesToClear.size === 0) return messages;

  // 7. 构造新数组,替换 stale tool message 的 content
  const newMessages: Message[] = messages.map((m, i) => {
    if (!indicesToClear.has(i)) return m;
    const entry = toolEntries.find((e) => e.msgIdx === i)!;
    const latestIdx = lastOccByKey.get(entry.key)!;
    const original = m as ToolMessage;
    const originalSize = original.content?.length ?? 0;
    const cleared: ToolMessage = {
      ...original,
      content:
        `[tool result cleared — ${entry.name}(${formatArgPreview(entry.args)}) was re-run later;` +
        ` see message at index ${latestIdx} for latest result. Original size: ${originalSize}B]`,
    };
    return cleared;
  });
  return newMessages;
}

/** 规范化参数用作分组 key。简单 JSON.stringify + key 排序。 */
function normalizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  const sortedEntries = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

/** Edit / Write / Read 的 args 取 file_path;Grep/Glob 等无对应概念则返 null。 */
function extractPath(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const fp = (args as { file_path?: unknown }).file_path;
  return typeof fp === "string" ? fp : null;
}

function formatArgPreview(args: unknown): string {
  if (args === null || typeof args !== "object") return String(args);
  const fp = (args as { file_path?: unknown }).file_path;
  if (typeof fp === "string") return fp;
  const pattern = (args as { pattern?: unknown }).pattern;
  if (typeof pattern === "string") return pattern;
  const s = JSON.stringify(args);
  return s.length > 50 ? s.slice(0, 50) + "…" : s;
}
