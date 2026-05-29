/**
 * 长期 Memory：跨 session 持久化的小段知识。
 *
 * 路径约定：~/.muse/projects/<projectHash>/memory/
 *   - MEMORY.md       index（每行 `- [Title](file.md) — one-line hook`）
 *   - <name>.md       具体记忆，带 frontmatter
 *
 * MEMORY.md 前 200 行自动注入 system prompt，让 LLM 每轮都看到。
 *
 * 类型：user / feedback / project / reference（对齐 Claude Code）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type MemoryType = "user" | "feedback" | "project" | "reference";

function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function memoryDir(cwd: string): string {
  return join(homedir(), ".muse", "projects", projectHash(cwd), "memory");
}

export function memoryIndexPath(cwd: string): string {
  return join(memoryDir(cwd), "MEMORY.md");
}

export function memoryFilePath(cwd: string, name: string): string {
  return join(memoryDir(cwd), `${name}.md`);
}

/** 加载 MEMORY.md 前 N 行供 system prompt 注入。 */
export async function loadMemoryIndex(cwd: string, maxLines = 200): Promise<string> {
  const path = memoryIndexPath(cwd);
  if (!existsSync(path)) return "";
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    if (lines.length <= maxLines) return raw.trim();
    return lines.slice(0, maxLines).join("\n").trim() + `\n... [truncated; ${lines.length - maxLines} more lines]`;
  } catch {
    return "";
  }
}

export async function readMemoryFile(cwd: string, name: string): Promise<string> {
  const path = memoryFilePath(cwd, name);
  if (!existsSync(path)) {
    throw new Error(`Memory "${name}" does not exist at ${path}.`);
  }
  return readFile(path, "utf-8");
}

export interface WriteMemoryOpts {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * 写一条 memory + 更新 MEMORY.md 索引。
 * - 若文件已存在，整体覆盖
 * - MEMORY.md 行匹配 `- [name](name.md) ` 前缀；存在则替换该行，否则追加
 */
export async function writeMemory(cwd: string, opts: WriteMemoryOpts): Promise<{ filePath: string; indexUpdated: boolean }> {
  const dir = memoryDir(cwd);
  await mkdir(dir, { recursive: true });

  const filePath = memoryFilePath(cwd, opts.name);
  const frontmatter = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description.replace(/\n/g, " ").trim()}`,
    `metadata:`,
    `  type: ${opts.type}`,
    "---",
  ].join("\n");
  const content = `${frontmatter}\n\n${opts.body.trim()}\n`;
  await writeFile(filePath, content, "utf-8");

  // 索引更新
  const indexPath = memoryIndexPath(cwd);
  let index = "";
  if (existsSync(indexPath)) index = await readFile(indexPath, "utf-8");
  const lines = index ? index.split("\n") : [];
  const linePrefix = `- [${opts.name}](${opts.name}.md)`;
  const newLine = `${linePrefix} — ${opts.description.replace(/\n/g, " ").trim()}`;
  const existing = lines.findIndex((l) => l.startsWith(linePrefix));
  let indexUpdated = false;
  if (existing >= 0) {
    if (lines[existing] !== newLine) {
      lines[existing] = newLine;
      indexUpdated = true;
    }
  } else {
    lines.push(newLine);
    indexUpdated = true;
  }
  if (indexUpdated) {
    const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    await writeFile(indexPath, out, "utf-8");
  }

  return { filePath, indexUpdated };
}
