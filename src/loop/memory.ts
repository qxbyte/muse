/**
 * 长期 Memory:跨 session 持久化的小段知识。
 *
 * 两层 scope(2026-06-07 设计扩展):
 *   - project:`~/.muse/projects/<projectHash>/memory/`(已有)
 *   - user:`~/.muse/memory/`(新增 — 跨项目用户级)
 *
 * 用户级 memory 对当前项目也生效,优先级低于项目级(召回时 project ×1.2)。
 *
 * 文件结构(每个 scope 内):
 *   - MEMORY.md       index(每行 `[trust] - [name](name.md) — one-line hook`)
 *   - <name>.md       具体记忆,带 frontmatter(含 trust + source + timestamps)
 *
 * trust 三级(模块设计/Agent 记忆系统/设计.md §4.4):
 *   - trusted   hierarchy 层(MUSE.md / AGENTS.md / managed)
 *   - verified  用户编辑过 / 显式 promote
 *   - auto      LLM 通过 MemoryWrite 自动写入,未审核(可被覆盖)
 *
 * source 来源:user-edit / user-remember / compact-promote / manual-write / imported / promote-scope。
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
export type Scope = "project" | "user";
export type MemorySource =
  | "user-edit"
  | "user-remember"
  | "compact-promote"
  | "manual-write"
  | "imported"
  | "promote-scope";

export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "verified", "auto"];
export const SCOPES: readonly Scope[] = ["project", "user"];

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
  scope: Scope;
}

function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

// ============================== 路径 helpers ==============================

export function memoryDir(cwd: string): string {
  return join(homedir(), ".muse", "projects", projectHash(cwd), "memory");
}

export function globalMemoryDir(): string {
  return join(homedir(), ".muse", "memory");
}

export function scopeDir(cwd: string, scope: Scope): string {
  return scope === "user" ? globalMemoryDir() : memoryDir(cwd);
}

export function memoryIndexPath(cwd: string, scope: Scope = "project"): string {
  return join(scopeDir(cwd, scope), "MEMORY.md");
}

export function memoryFilePath(cwd: string, name: string, scope: Scope = "project"): string {
  return join(scopeDir(cwd, scope), `${name}.md`);
}

// ============================== 加载 / 读取 ==============================

/** 加载 MEMORY.md 前 N 行供 system prompt 注入。
 *  默认合并两层:project 在前 + user 在后(用 `---` 分隔)。 */
export async function loadMemoryIndex(cwd: string, maxLines = 200): Promise<string> {
  const parts: string[] = [];
  for (const scope of SCOPES) {
    const path = memoryIndexPath(cwd, scope);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf-8");
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const tag = scope === "project" ? "# project memory" : "# user (global) memory";
      parts.push(`${tag}\n${trimmed}`);
    } catch {
      // skip
    }
  }
  if (parts.length === 0) return "";
  const full = parts.join("\n\n---\n\n");
  const lines = full.split("\n");
  if (lines.length <= maxLines) return full;
  return lines.slice(0, maxLines).join("\n") + `\n... [truncated; ${lines.length - maxLines} more lines]`;
}

/**
 * 读取单条 memory:scope 未指定时**先 project,fallback user**;name 在两层都存在
 * 时 scope 显式可消歧。
 *
 * 旧文件无 trust/source/timestamps 时**懒填**(基于 file mtime),不写回磁盘。
 */
export async function readMemory(cwd: string, name: string, scope?: Scope): Promise<MemoryFile> {
  const candidates: Scope[] = scope ? [scope] : ["project", "user"];
  for (const s of candidates) {
    const filePath = memoryFilePath(cwd, name, s);
    if (!existsSync(filePath)) continue;
    const raw = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseMemoryFile(raw, name, filePath);
    return { frontmatter, body, filePath, scope: s };
  }
  const where = scope ? `${scope} scope` : `project or user scope`;
  throw new Error(`Memory "${name}" does not exist in ${where}.`);
}

/** 仅返回文件原文(含 frontmatter)。MemoryRead 工具用此让 LLM 看到 trust + scope。 */
export async function readMemoryFile(cwd: string, name: string, scope?: Scope): Promise<string> {
  const file = await readMemory(cwd, name, scope);
  return readFile(file.filePath, "utf-8");
}

// ============================== 写入 ==============================

export interface WriteMemoryOpts {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** 默认 "auto"。 */
  trust?: TrustLevel;
  /** 默认 "manual-write"。 */
  source?: MemorySource;
  /** 默认 "project"。LLM 自行判断 / /remember 命令显式覆盖。 */
  scope?: Scope;
}

export interface WriteMemoryResult {
  filePath: string;
  indexUpdated: boolean;
  /** 新建文件 = true;更新已有 = false。 */
  created: boolean;
  /** 写入的实际 scope(便于 caller 提示)。 */
  scope: Scope;
}

/**
 * 写一条 memory + 更新对应 scope 的 MEMORY.md 索引。
 *
 * 行为:
 *   - 新建:落 frontmatter + body,created_at = updated_at = now
 *   - 已存在(同 scope):**保留**原 created_at,刷新 updated_at;trust 走升级语义
 *     (不能从 verified 自动降回 auto;trusted 永久不变)
 *   - 跨 scope 同名:两层独立存储,各自独立 frontmatter
 *   - 索引:替换或追加 `[trust] - [name](name.md) — description` 行
 */
export async function writeMemory(cwd: string, opts: WriteMemoryOpts): Promise<WriteMemoryResult> {
  const scope = opts.scope ?? "project";
  const dir = scopeDir(cwd, scope);
  await mkdir(dir, { recursive: true });

  const filePath = memoryFilePath(cwd, opts.name, scope);
  const now = new Date().toISOString();
  const reqTrust: TrustLevel = opts.trust ?? "auto";
  const reqSource = opts.source ?? "manual-write";

  let createdAt = now;
  let finalTrust: TrustLevel = reqTrust;
  let finalSource: string = reqSource;
  const isCreating = !existsSync(filePath);

  if (!isCreating) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const existing = parseMemoryFile(raw, opts.name, filePath).frontmatter;
      createdAt = existing.created_at;
      if (trustRank(existing.trust) > trustRank(reqTrust)) {
        finalTrust = existing.trust;
        finalSource = existing.source;
      }
    } catch {
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

  const indexUpdated = await upsertIndexLine(cwd, scope, fm);
  return { filePath, indexUpdated, created: isCreating, scope };
}

/**
 * 改 trust 但不动 body / description(同 scope 内)。用于:
 *   - /memory edit 退出后自动升 verified
 *   - /memory promote(auto → verified)
 *   - /memory trust <verified|auto> 显式改
 *
 * 只升不降语义:trustRank(new) >= trustRank(old);否则报错。
 * scope 未指定 → 走 readMemory 自动定位规则。
 */
export async function setMemoryTrust(
  cwd: string,
  name: string,
  trust: TrustLevel,
  source: MemorySource = "user-edit",
  scope?: Scope,
): Promise<void> {
  const file = await readMemory(cwd, name, scope);
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
  await upsertIndexLine(cwd, file.scope, fm);
}

/** 删除单条 memory + 从对应 scope 索引移除。scope 未指定 → 自动定位。 */
export async function deleteMemory(cwd: string, name: string, scope?: Scope): Promise<Scope> {
  // 先确定 actual scope
  let actualScope: Scope | undefined = scope;
  if (!actualScope) {
    for (const s of SCOPES) {
      if (existsSync(memoryFilePath(cwd, name, s))) {
        actualScope = s;
        break;
      }
    }
  }
  if (!actualScope) {
    throw new Error(`Memory "${name}" does not exist in any scope.`);
  }
  const filePath = memoryFilePath(cwd, name, actualScope);
  if (existsSync(filePath)) await unlink(filePath);
  await removeIndexLine(cwd, actualScope, name);
  return actualScope;
}

/**
 * 把 project scope 的 memory 提升到 user scope(II-3 promote-scope)。
 * 行为:
 *   1. 从 project 读 → 写入 user(保留 created_at;source 改 promote-scope)
 *   2. 删除 project 下的原文件 + 索引行
 *   3. 失败任一步骤抛错(原子性:写 user 失败时不删 project)
 *
 * 已在 user scope:noop 返回 false。
 */
export async function promoteScopeToUser(cwd: string, name: string): Promise<boolean> {
  const projectPath = memoryFilePath(cwd, name, "project");
  const userPath = memoryFilePath(cwd, name, "user");
  if (!existsSync(projectPath)) {
    if (existsSync(userPath)) return false; // 已经在 user scope
    throw new Error(`Memory "${name}" does not exist in project scope.`);
  }
  if (existsSync(userPath)) {
    throw new Error(`Memory "${name}" already exists in user scope. Delete one of them first.`);
  }
  const file = await readMemory(cwd, name, "project");
  await writeMemory(cwd, {
    name: file.frontmatter.name,
    description: file.frontmatter.description,
    type: file.frontmatter.type,
    body: file.body,
    trust: file.frontmatter.trust,
    source: "promote-scope",
    scope: "user",
  });
  await deleteMemory(cwd, name, "project");
  return true;
}

// ============================== 列表 ==============================

export interface ListMemoriesOpts {
  /** "project" | "user" | "all"(默认)。 */
  scope?: Scope | "all";
}

/** 列出 memory(按 trust → updated_at 降序;all 时合并两层)。 */
export async function listMemories(cwd: string, opts: ListMemoriesOpts = {}): Promise<MemoryFile[]> {
  const scope = opts.scope ?? "all";
  const targets: Scope[] = scope === "all" ? ["project", "user"] : [scope];
  const files: MemoryFile[] = [];
  for (const s of targets) {
    const dir = scopeDir(cwd, s);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry === "MEMORY.md") continue;
      const name = entry.replace(/\.md$/, "");
      try {
        files.push(await readMemory(cwd, name, s));
      } catch {
        // skip 损坏文件
      }
    }
  }
  files.sort((a, b) => {
    // 优先 trust,再 updated_at,scope 仅做最后 tie-break(project 在前)
    const t = trustRank(b.frontmatter.trust) - trustRank(a.frontmatter.trust);
    if (t !== 0) return t;
    const u = b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
    if (u !== 0) return u;
    if (a.scope === b.scope) return 0;
    return a.scope === "project" ? -1 : 1;
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
 * 缺失字段懒填:trust=auto, source=manual-write, created_at = file.mtime,
 * updated_at = created_at, type = "user"(兜底)。
 */
function parseMemoryFile(
  raw: string,
  fallbackName: string,
  filePath: string,
): { frontmatter: MemoryFrontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
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
      if (!line.match(/^\s+\S/)) {
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
  if (/[:#&*?{}[\]|>!%@`]/.test(v) || v.startsWith(" ") || v.endsWith(" ")) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}

// ============================== MEMORY.md 索引 ==============================

const INDEX_LINE_RE = /^\[(trusted|verified|auto)\]\s+-\s+\[([a-zA-Z0-9-_]+)\]\(([^)]+)\)\s+—\s+(.*)$/;

function formatIndexLine(fm: MemoryFrontmatter): string {
  return `[${fm.trust}] - [${fm.name}](${fm.name}.md) — ${fm.description}`;
}

async function upsertIndexLine(cwd: string, scope: Scope, fm: MemoryFrontmatter): Promise<boolean> {
  const indexPath = memoryIndexPath(cwd, scope);
  let index = existsSync(indexPath) ? await readFile(indexPath, "utf-8") : "";
  const lines = index ? index.split("\n") : [];
  const newLine = formatIndexLine(fm);

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
    await mkdir(scopeDir(cwd, scope), { recursive: true });
    await writeFile(indexPath, out, "utf-8");
  }
  return changed;
}

async function removeIndexLine(cwd: string, scope: Scope, name: string): Promise<void> {
  const indexPath = memoryIndexPath(cwd, scope);
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
