/**
 * Slash 命令体共享的格式化 helper。
 *
 * 之所以单独抽：命令文件应该薄、只编排；shortPath / 表格对齐 / flag 解析
 * 被多个命令复用，三处相似就抽（CLAUDE.md 代码风格条款）。
 */

import { homedir } from "node:os";

export function shortPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

export function formatList(list: string[] | undefined): string {
  if (!list || list.length === 0) return "(none)";
  return list.join(", ");
}

/**
 * 解析 "--key val --flag pos1 pos2" 形式。极简，够 v0.1 用：
 *   - 不支持 = 形式
 *   - 不支持引号转义
 *   - bool flag 默认 false，出现即 true
 */
export function parseArgs(raw: string): { positional: string[]; flags: Record<string, string | boolean> } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

/**
 * "provider/model" 或 "model" 解析。后者沿用当前 provider。
 */
export function parseModelSpec(
  spec: string,
  fallbackProvider: string,
): { provider: string; model: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: fallbackProvider, model: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/** "yyyy-mm-dd hh:mm" 紧凑时间。 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
