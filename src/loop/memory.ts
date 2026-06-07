/**
 * 长期 Memory:跨 session 持久化的小段知识。
 *
 * 路径约定:~/.muse/projects/<projectHash>/memory/
 *   - MEMORY.md       index(每行 `[trust] - [name](name.md) — one-line hook`)
 *   - <name>.md       具体记忆,带 frontmatter(含 trust + source + timestamps)
 *
 * MEMORY.md 前 200 行自动注入 system prompt,让 LLM 每轮都看到。
 *
 * trust 三级(模块设计/Agent 记忆系统/设计.md §4.4):
 *   - trusted   hierarchy 层(MUSE.md / AGENTS.md / managed)
 *   - verified  用户编辑过 / 显式 promote
 *   - auto      LLM 通过 MemoryWrite 自动写入,未审核(可被覆盖)
 *
 * source 来源:user-edit / user-remember / compact-promote / manual-write / imported。
 *
 * 类型:user / feedback / project / reference。
 */

import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type TrustLevel = "trusted" | "verified" | "auto";
export type MemorySource =
  | "user-edit"
  | "user-remember"
  | "compact-promote"
  | "manual-write"
  | "imported";

export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "verified", "auto"];

/**
 * trust 排序:trusted > verified > auto。
 * II-5 向量召回的加权 / II-3 list 排序 用此函数比较。
 */
export function trustRank(t: TrustLevel): number {
  switch (t) {
    case "trusted":
      return 2;
    case "verified":
      return 1;
    case "auto":
      return 0;
  }
}

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  trust: TrustLevel;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryFile {
  frontmatter: MemoryFrontmatter;
  body: string;
  filePath: string;
}

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

/**
 * 读取 memory 文件 + 解析 frontmatter。
 * 旧文件无 trust/source/timestamps 时**懒填**:trust=auto, source=manual-write,
 * created_at = file mtime ISO,updated_at = 同 created_at。**不写回磁盘** —
 * 下一次 writeMemory 触发时再持久化完整 frontmatter,避免读路径副作用。
 */
export async function readMemory(cwd: string, name: string): Promise<MemoryFile> {
  const filePath = memoryFilePath(cwd, name);
  if (!existsSync(filePath)) {
    throw new Error(`Memory "${name}" does not exist at ${filePath}.`);
  }
  const raw = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseMemoryFile(raw, name, filePath);
  return { frontmatter, body, filePath };
}

/** 仅返回文件原文(含 frontmatter)。MemoryRead 工具用此让 LLM 看到 trust 等元数据。 */
export async function readMemoryFile(cwd: string, name: string): Promise<string> {
  const filePath = memoryFilePath(cwd, name);
  if (!existsSync(filePath)) {
    throw new Error(`Memory "${name}" does not exist at ${filePath}.`);
  }
  return readFile(filePath, "utf-8");
}

export interface WriteMemoryOpts {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** 默认 "auto"。 */
  trust?: TrustLevel;
  /** 默认 "manual-write"。 */
  source?: MemorySource;
}

export interface WriteMemoryResult {
  filePath: string;
  indexUpdated: boolean;
  /** 新建文件 = true;更新已有 = false。 */
  created: boolean;
}

/**
 * 写一条 memory + 更新 MEMORY.md 索引。
 *
 * 行为:
 *   - 新建:落 frontmatter + body,created_at = updated_at = now
 *   - 已存在:**保留**原 created_at,刷新 updated_at;trust 走升级语义(不能从
 *     verified 自动降回 auto;trusted 永久不变)
 *   - 索引:替换或追加 `[trust] - [name](name.md) — description` 行
 */
export async function writeMemory(cwd: string, opts: WriteMemoryOpts): Promise<WriteMemoryResult> {
  const dir = memoryDir(cwd);
  await mkdir(dir, { recursive: true });

  const filePath = memoryFilePath(cwd, opts.name);
  const now = new Date().toISOString();
  const reqTrust: TrustLevel = opts.trust ?? "auto";
  const reqSource = opts.source ?? "manual-write";

  let createdAt = now;
  let finalTrust: TrustLevel = reqTrust;
  let finalSource: string = reqSource;
  const isCreating = !existsSync(filePath);

  if (!isCreating) {
    // 读已有 frontmatter,保留 created_at,trust 走"只升不降"
    try {
      const raw = await readFile(filePath, "utf-8");
      const existing = parseMemoryFile(raw, opts.name, filePath).frontmatter;
      createdAt = existing.created_at;
      // 升级语义:max(req, existing);trusted 不会被 auto/verified 覆盖
      if (trustRank(existing.trust) > trustRank(reqTrust)) {
        finalTrust = existing.trust;
        finalSource = existing.source;
      }
    } catch {
      // 解析失败 → 当新建处理(原文件可能损坏,覆盖修复)
      createdAt = now;
    }
  }

  const fm: MemoryFrontmatter = {
    name: opts.name,
    description: opts.description.replace(/\n/g, " ").trim(),
    type: opts.type,
    trust: finalTrust,
    source: finalSource,
    created_at: createdAt,
    updated_at: now,
  };

  const content = serializeMemoryFile(fm, opts.body);
  await writeFile(filePath, content, "utf-8");

  const indexUpdated = await upsertIndexLine(cwd, fm);
  return { filePath, indexUpdated, created: isCreating };
}

/**
 * 改 trust 但不动 body / description。用于:
 *   - /memory edit 退出后自动升 verified
 *   - /memory promote(auto → verified;verified → trusted 仅 hierarchy 允许)
 *   - /memory trust <verified|auto> 显式改
 *
 * 只升不降语义:trustRank(new) >= trustRank(old);否则报错。
 */
export async function setMemoryTrust(
  cwd: string,
  name: string,
  trust: TrustLevel,
  source: MemorySource = "user-edit",
): Promise<void> {
  const file = await readMemory(cwd, name);
  if (trustRank(trust) < trustRank(file.frontmatter.trust)) {
    throw new Error(
      `Cannot lower trust: "${name}" is currently ${file.frontmatter.trust}; ${trust} would be a downgrade.`,
    );
  }
  if (trust === file.frontmatter.trust && source === file.frontmatter.source) {
    return; // no-op
  }
  const fm: MemoryFrontmatter = {
    ...file.frontmatter,
    trust,
    source,
    updated_at: new Date().toISOString(),
  };
  const content = serializeMemoryFile(fm, file.body);
  await writeFile(file.filePath, content, "utf-8");
  await upsertIndexLine(cwd, fm);
}

/** 删除单条 memory + 从索引移除。 */
export async function deleteMemory(cwd: string, name: string): Promise<void> {
  const filePath = memoryFilePath(cwd, name);
  if (existsSync(filePath)) await unlink(filePath);
  await removeIndexLine(cwd, name);
}

/** 列出 memory/ 目录下所有 .md(MEMORY.md 除外),按 trust → updated_at 降序排。 */
export async function listMemories(cwd: string): Promise<MemoryFile[]> {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files: MemoryFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry === "MEMORY.md") continue;
    const name = entry.replace(/\.md$/, "");
    try {
      files.push(await readMemory(cwd, name));
    } catch {
      // 单条解析失败不影响 list
    }
  }
  files.sort((a, b) => {
    const t = trustRank(b.frontmatter.trust) - trustRank(a.frontmatter.trust);
    if (t !== 0) return t;
    return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
  });
  return files;
}

// ============================== frontmatter 内部实现 ==============================

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * 极简 frontmatter 解析。仅识别:
 *   name / description    顶层 key: value
 *   metadata:             嵌套块,缩进的 key: value
 *
 * 不支持通用 YAML(嵌套 list / 多行字符串等)— 因为 muse memory 写入是固定模板,
 * 不会出现复杂结构。容错:未知字段保留为 unknown 但不丢失。
 *
 * 缺失字段懒填(基于 file mtime / 默认值):trust=auto, source=manual-write,
 * created_at = file.mtime ISO, updated_at = created_at, type = "user"(兜底).
 */
function parseMemoryFile(
  raw: string,
  fallbackName: string,
  filePath: string,
): { frontmatter: MemoryFrontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    // 无 frontmatter — 全文当 body,frontmatter 全懒填
    return {
      frontmatter: lazyDefaults(fallbackName, "", filePath),
      body: raw.trim(),
    };
  }
  const fmText = m[1];
  const body = raw.slice(m[0].length).trim();

  const lines = fmText.split("\n");
  let name = fallbackName;
  let description = "";
  let type: MemoryType = "user";
  let trust: TrustLevel = "auto";
  let source = "manual-write";
  let createdAt = "";
  let updatedAt = "";
  let inMetadata = false;

  for (const line of lines) {
    if (line.match(/^metadata:\s*$/)) {
      inMetadata = true;
      continue;
    }
    if (!inMetadata) {
      const kv = parseKV(line);
      if (!kv) continue;
      if (kv.key === "name") name = kv.value;
      else if (kv.key === "description") description = kv.value;
    } else {
      // metadata 子项必须有缩进
      if (!line.match(/^\s+\S/)) {
        // 退出 metadata 块
        inMetadata = false;
        continue;
      }
      const kv = parseKV(line);
      if (!kv) continue;
      switch (kv.key) {
        case "type":
          if (isMemoryType(kv.value)) type = kv.value;
          break;
        case "trust":
          if (isTrustLevel(kv.value)) trust = kv.value;
          break;
        case "source":
          source = kv.value;
          break;
        case "created_at":
          createdAt = kv.value;
          break;
        case "updated_at":
          updatedAt = kv.value;
          break;
      }
    }
  }

  // 懒填缺失字段
  if (!createdAt || !updatedAt) {
    const mtimeIso = safeFileMtime(filePath);
    if (!createdAt) createdAt = mtimeIso;
    if (!updatedAt) updatedAt = createdAt;
  }

  return {
    frontmatter: { name, description, type, trust, source, created_at: createdAt, updated_at: updatedAt },
    body,
  };
}

function parseKV(line: string): { key: string; value: string } | null {
  const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2];
  // 去外层引号(若有)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function isMemoryType(v: string): v is MemoryType {
  return v === "user" || v === "feedback" || v === "project" || v === "reference";
}

function isTrustLevel(v: string): v is TrustLevel {
  return v === "trusted" || v === "verified" || v === "auto";
}

function safeFileMtime(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function lazyDefaults(name: string, description: string, filePath: string): MemoryFrontmatter {
  const mtimeIso = safeFileMtime(filePath);
  return {
    name,
    description,
    type: "user",
    trust: "auto",
    source: "manual-write",
    created_at: mtimeIso,
    updated_at: mtimeIso,
  };
}

function serializeMemoryFile(fm: MemoryFrontmatter, body: string): string {
  const lines = [
    "---",
    `name: ${fm.name}`,
    `description: ${escapeYamlValue(fm.description)}`,
    "metadata:",
    `  type: ${fm.type}`,
    `  trust: ${fm.trust}`,
    `  source: ${fm.source}`,
    `  created_at: ${fm.created_at}`,
    `  updated_at: ${fm.updated_at}`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

function escapeYamlValue(v: string): string {
  // 含 `:` 或行首特殊字符的值用双引号;其他原样
  if (/[:#&*?{}[\]|>!%@`]/.test(v) || v.startsWith(" ") || v.endsWith(" ")) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}

// ============================== MEMORY.md 索引 ==============================

const INDEX_LINE_RE = /^\[(trusted|verified|auto)\]\s+-\s+\[([a-zA-Z0-9-_]+)\]\(([^)]+)\)\s+—\s+(.*)$/;

/** 索引一行格式:`[trust] - [name](name.md) — description`。 */
function formatIndexLine(fm: MemoryFrontmatter): string {
  return `[${fm.trust}] - [${fm.name}](${fm.name}.md) — ${fm.description}`;
}

async function upsertIndexLine(cwd: string, fm: MemoryFrontmatter): Promise<boolean> {
  const indexPath = memoryIndexPath(cwd);
  let index = existsSync(indexPath) ? await readFile(indexPath, "utf-8") : "";
  const lines = index ? index.split("\n") : [];
  const newLine = formatIndexLine(fm);

  // 找已有(按 name 匹配,无论 trust 是否变)— 旧格式 `- [name](...)` 也能命中
  const existingIdx = lines.findIndex((l) => {
    const m = l.match(INDEX_LINE_RE);
    if (m) return m[2] === fm.name;
    return l.startsWith(`- [${fm.name}](${fm.name}.md)`);
  });

  let changed = false;
  if (existingIdx >= 0) {
    if (lines[existingIdx] !== newLine) {
      lines[existingIdx] = newLine;
      changed = true;
    }
  } else {
    lines.push(newLine);
    changed = true;
  }
  if (changed) {
    const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    await writeFile(indexPath, out, "utf-8");
  }
  return changed;
}

async function removeIndexLine(cwd: string, name: string): Promise<void> {
  const indexPath = memoryIndexPath(cwd);
  if (!existsSync(indexPath)) return;
  const raw = await readFile(indexPath, "utf-8");
  const lines = raw.split("\n");
  const next = lines.filter((l) => {
    const m = l.match(INDEX_LINE_RE);
    if (m) return m[2] !== name;
    return !l.startsWith(`- [${name}](${name}.md)`);
  });
  if (next.length !== lines.length) {
    const out = next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    await writeFile(indexPath, out, "utf-8");
  }
}
