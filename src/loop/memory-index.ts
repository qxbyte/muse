/**
 * Memory 向量索引(II-5)。
 *
 * 设计文档:模块设计/Agent 记忆系统/设计.md §4.5。
 *
 * 持久化:每个 scope 一份 .index.json(自家 JSON;ADR D8-rev 拍板,不用 LanceDB):
 *   - `~/.muse/projects/<hash>/memory/.index.json`(项目层)
 *   - `~/.muse/memory/.index.json`(全局层)
 *
 * 数据结构(每份):
 *   PersistentIndex = { providerId, dim, entries: { [name]: { mtime, vector, ... } } }
 *
 * 启动 / 增量行为(每个 scope 独立):
 *   1. 读 .index.json,如果 providerId 一致 → entries 复用
 *   2. 列 memory/*.md,逐条对照 mtime;一致复用 vector,不一致重 embed
 *   3. .index.json 中 name 不在当前 memory 目录 → 删除该 entry
 *   4. providerId 切换 → 全量重 embed,文件覆盖
 *
 * 召回(R1 + R3):
 *   - **embed 输入只用 `name + description`**(短而精,语义聚焦;body 留作召回后注入素材)
 *   - query → embed → 余弦相似度 × 双重加权(trustW × scopeW)
 *   - trustW:trusted ×1.5 / verified ×1.2 / auto ×1.0
 *   - scopeW:project ×1.2 / user ×1.0
 *
 * 冷启动保护:memoryCount < minMemoryCount(默认 3,2026-06-07 修订;原 10 过激)
 *   → 退化到全注入。
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  listMemories,
  readMemory,
  memoryDir,
  globalMemoryDir,
  scopeDir,
  type MemoryFile,
  type MemoryType,
  type TrustLevel,
  type Scope,
  SCOPES,
  trustRank,
} from "./memory.js";
import {
  createEmbeddingProvider,
  createAndProbeProvider,
  cosineSimilarity,
  type EmbeddingProvider,
  type EmbeddingConfig,
  type ExtendedEmbeddingConfig,
} from "./embedding/index.js";

export interface MemoryIndexEntry {
  name: string;
  type: MemoryType;
  trust: TrustLevel;
  scope: Scope;
  description: string;
  /** 用于注入 prompt 的"行格式"片段:`[trust] - [name](name.md) — description`。 */
  rawIndexLine: string;
  /** 完整 frontmatter + body(给召回结果详情展示用)。 */
  bodySnippet: string;
  /** 完整 body(注入分级用:trusted 完整 / verified 摘要 / auto 不用)。 */
  fullBody: string;
  vector: number[];
}

export interface MemoryIndex {
  provider: EmbeddingProvider;
  entries: MemoryIndexEntry[];
  /** 索引构建时刻 ISO。 */
  builtAt: string;
  /** cwd(用于增量 upsert / remove 操作时找文件)。 */
  cwd: string;
}

/** 落盘格式(.index.json):name → 持久化条目 + provider 元数据 + dim。 */
interface PersistentIndex {
  providerId: string;
  dim: number;
  schemaVersion: 1;
  entries: { [name: string]: PersistentEntry };
}

interface PersistentEntry {
  mtime: string;
  type: MemoryType;
  trust: TrustLevel;
  description: string;
  bodySnippet: string;
  fullBody: string;
  vector: number[];
}

export interface BuildIndexOpts {
  config?: ExtendedEmbeddingConfig;
  /** 自定义 provider(测试用);提供时覆盖 config。 */
  provider?: EmbeddingProvider;
  /** 是否禁用磁盘持久化(测试 / 临时场景)。默认 false。 */
  noPersist?: boolean;
  /** 是否跳过 probe 校验(测试 / hash-bag 场景默认跳过)。默认 false(自动按 provider id 判断)。 */
  skipProbe?: boolean;
}

function indexPath(cwd: string, scope: Scope): string {
  return join(scopeDir(cwd, scope), ".index.json");
}

async function readPersistent(cwd: string, scope: Scope): Promise<PersistentIndex | null> {
  const path = indexPath(cwd, scope);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.schemaVersion !== 1) return null;
    return parsed as PersistentIndex;
  } catch {
    return null;
  }
}

async function writePersistent(cwd: string, scope: Scope, persistent: PersistentIndex): Promise<void> {
  const dir = scopeDir(cwd, scope);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(cwd, scope), JSON.stringify(persistent), "utf-8");
}

function snippet(body: string): string {
  return body.length > 400 ? body.slice(0, 400) + "\n... [truncated]" : body;
}

/** R1:embed 输入只用 `name + description`(短而精,语义聚焦)。 */
function embedInputText(f: MemoryFile): string {
  return `${f.frontmatter.name}: ${f.frontmatter.description}`;
}

async function embedMemoryFile(provider: EmbeddingProvider, f: MemoryFile): Promise<PersistentEntry> {
  const fm = f.frontmatter;
  const vector = await provider.embed(embedInputText(f));
  return {
    mtime: fm.updated_at,
    type: fm.type,
    trust: fm.trust,
    description: fm.description,
    bodySnippet: snippet(f.body),
    fullBody: f.body,
    vector,
  };
}

function makeEntry(name: string, scope: Scope, p: PersistentEntry): MemoryIndexEntry {
  return {
    name,
    type: p.type,
    trust: p.trust,
    scope,
    description: p.description,
    rawIndexLine: `[${p.trust}] - [${name}](${name}.md) — ${p.description}`,
    bodySnippet: p.bodySnippet,
    fullBody: p.fullBody,
    vector: p.vector,
  };
}

/**
 * 从 cwd 下所有 memory 文件构建向量索引(同时遍历 project + user 两 scope)。
 *
 * 行为(2026-06-07 D8-rev + scope 双层):
 *   每个 scope 独立处理:
 *   1. 读 .index.json
 *   2. 如果 providerId 不匹配 → 整库 invalidate,全部重 embed
 *   3. 否则按 mtime 增量:一致复用,不一致重 embed,删除多余
 *   4. 写回 .index.json
 *
 * 输出合并的 entries(每条带 scope 字段),按 scope 顺序 project → user。
 */
export async function buildMemoryIndex(cwd: string, opts: BuildIndexOpts = {}): Promise<MemoryIndex> {
  // 优先用 caller 注入的 provider;否则按配置创建并(默认)做 probe 校验
  let provider: EmbeddingProvider;
  if (opts.provider) {
    provider = opts.provider;
  } else if (opts.skipProbe) {
    provider = createEmbeddingProvider(opts.config);
  } else {
    provider = await createAndProbeProvider(opts.config ?? {});
  }
  const allEntries: MemoryIndexEntry[] = [];

  for (const scope of SCOPES) {
    const files = await listMemories(cwd, { scope });
    if (files.length === 0) continue;

    const persistent = opts.noPersist ? null : await readPersistent(cwd, scope);
    const sameProvider = persistent?.providerId === provider.id && persistent?.dim === provider.dim;
    const oldEntries = sameProvider ? persistent!.entries : {};

    const newEntries: { [name: string]: PersistentEntry } = {};
    for (const f of files) {
      const name = f.frontmatter.name;
      const old = oldEntries[name];
      if (old && old.mtime === f.frontmatter.updated_at) {
        newEntries[name] = {
          ...old,
          type: f.frontmatter.type,
          trust: f.frontmatter.trust,
          description: f.frontmatter.description,
          bodySnippet: snippet(f.body),
          fullBody: f.body,
        };
      } else {
        newEntries[name] = await embedMemoryFile(provider, f);
      }
    }

    if (!opts.noPersist) {
      await writePersistent(cwd, scope, {
        providerId: provider.id,
        dim: provider.dim,
        schemaVersion: 1,
        entries: newEntries,
      });
    }

    for (const [name, p] of Object.entries(newEntries)) {
      allEntries.push(makeEntry(name, scope, p));
    }
  }

  return { provider, entries: allEntries, builtAt: new Date().toISOString(), cwd };
}

/**
 * 增量 upsert:MemoryWrite 后调用,把单条 memory 加入或更新到已有索引。
 * scope 不指定时按 readMemory 规则自动定位(project 优先 fallback user)。
 */
export async function upsertMemoryEntry(index: MemoryIndex, name: string, scope?: Scope): Promise<void> {
  let f: MemoryFile;
  try {
    f = await readMemory(index.cwd, name, scope);
  } catch {
    return;
  }
  const p = await embedMemoryFile(index.provider, f);

  // in-memory 数组 upsert
  const idx = index.entries.findIndex((e) => e.name === name && e.scope === f.scope);
  const newEntry = makeEntry(name, f.scope, p);
  if (idx >= 0) index.entries[idx] = newEntry;
  else index.entries.push(newEntry);

  // 落盘(该 scope 的 .index.json)
  const persistent = (await readPersistent(index.cwd, f.scope)) ?? {
    providerId: index.provider.id,
    dim: index.provider.dim,
    schemaVersion: 1 as const,
    entries: {},
  };
  persistent.entries[name] = p;
  await writePersistent(index.cwd, f.scope, persistent);
}

/**
 * 移除单条 entry:deleteMemory 后调用。
 * scope 指定时只删该层;不指定时项目 + 全局都尝试删(无害,name 不存在不抛错)。
 */
export async function removeMemoryEntry(index: MemoryIndex, name: string, scope?: Scope): Promise<void> {
  const targets: Scope[] = scope ? [scope] : ["project", "user"];
  for (const s of targets) {
    // in-memory
    const idx = index.entries.findIndex((e) => e.name === name && e.scope === s);
    if (idx >= 0) index.entries.splice(idx, 1);
    // 落盘
    const persistent = await readPersistent(index.cwd, s);
    if (persistent && persistent.entries[name]) {
      delete persistent.entries[name];
      await writePersistent(index.cwd, s, persistent);
    }
  }
}

/** 强制 invalidate 某 scope 的索引文件,下次 buildMemoryIndex 全量重 embed。 */
export async function clearPersistedIndex(cwd: string, scope?: Scope): Promise<void> {
  const targets: Scope[] = scope ? [scope] : ["project", "user"];
  for (const s of targets) {
    const path = indexPath(cwd, s);
    if (!existsSync(path)) continue;
    try {
      await unlink(path);
    } catch {
      // ignore
    }
  }
}

// ============================== 查询 / 召回 ==============================

export interface QueryOpts {
  /** top-K(默认 5)。 */
  topK?: number;
  /** 最低相似度阈值(默认 0;降低阈值召回更多但噪音多)。 */
  minScore?: number;
}

export interface QueryResult {
  entry: MemoryIndexEntry;
  /** 余弦相似度(0-1)。 */
  score: number;
  /** trust × scope 双重加权后的最终排序分。 */
  weighted: number;
}

/**
 * 召回:embed query → 双重加权(trust × scope) → top-K。
 *
 * 加权公式(R3 拍板):
 *   weighted = cosine × trustW × scopeW
 *
 *   trustW:trusted ×1.5 / verified ×1.2 / auto ×1.0
 *   scopeW:project ×1.2 / user ×1.0
 */
export async function queryMemoryIndex(
  index: MemoryIndex,
  queryText: string,
  opts: QueryOpts = {},
): Promise<QueryResult[]> {
  if (index.entries.length === 0) return [];
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  const queryVec = await index.provider.embed(queryText);
  const scored = index.entries
    .map((entry) => {
      const score = cosineSimilarity(queryVec, entry.vector);
      const weighted = score * trustWeight(entry.trust) * scopeWeight(entry.scope);
      return { entry, score, weighted };
    })
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.weighted - a.weighted);
  return scored.slice(0, topK);
}

/** trust 加权:trusted ×1.5,verified ×1.2,auto ×1.0(R3 设计 §4.5)。 */
function trustWeight(t: TrustLevel): number {
  switch (t) {
    case "trusted":
      return 1.5;
    case "verified":
      return 1.2;
    case "auto":
      return 1.0;
  }
}

/** scope 加权:project ×1.2,user ×1.0(R3 — 项目优先 > 全局)。 */
function scopeWeight(s: Scope): number {
  return s === "project" ? 1.2 : 1.0;
}

/** 把召回结果格式化为可注入 system prompt 的索引段(替代 loadMemoryIndex)。
 *  本函数只输出索引行;trust 分级 body 注入由 inject-memory stage 完成。 */
export function formatRetrievedAsIndex(results: QueryResult[]): string {
  if (results.length === 0) return "";
  return results.map((r) => r.entry.rawIndexLine).join("\n");
}

export { trustRank, trustWeight, scopeWeight };
