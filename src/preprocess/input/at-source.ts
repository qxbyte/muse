/**
 * @ 引用的 fuzzy 候选源。
 *
 * 设计:
 *   - 无 `/` 在 query 里:fast-glob 扫 cwd 全树(默认排除 node_modules / .git),
 *     按 fuzzy score 排序;限 1000 条候选,picker UI 再窗口截取
 *   - 含 `/`:解析出目录前缀 + 子查询,只列该目录下子项(逐级展开,大目录友好)
 *   - LRU 缓存:同一 cwd 的全树扫描结果缓存 5 秒,避免每次按键重扫
 *
 * 性能考量:键盘事件每次按键都会重 query;扫盘放 async + cache 即可,Ink render
 * 拿到 promise resolve 后更新候选列表。
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import fg from "fast-glob";

export interface AtCandidate {
  /** 相对 cwd 的路径,UI 直接显示。 */
  rel: string;
  /** 是否为目录。目录后缀加 `/` 视觉提示 + 选中后继续展开。 */
  isDir: boolean;
}

/** 全树扫描默认排除模式。 */
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.muse/**",
];

const MAX_RESULTS = 1000;
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  cwd: string;
  at: number;
  files: AtCandidate[];
}

let cache: CacheEntry | null = null;

/** 清缓存(测试用)。 */
export function _clearAtCache(): void {
  cache = null;
}

async function loadAllFiles(cwd: string): Promise<AtCandidate[]> {
  const now = Date.now();
  if (cache && cache.cwd === cwd && now - cache.at < CACHE_TTL_MS) {
    return cache.files;
  }
  const entries = await fg("**/*", {
    cwd,
    dot: true,
    onlyFiles: false,
    markDirectories: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE,
    suppressErrors: true,
  });
  const files: AtCandidate[] = entries.slice(0, MAX_RESULTS * 5).map((e) => ({
    rel: e.endsWith("/") ? e.slice(0, -1) : e,
    isDir: e.endsWith("/"),
  }));
  cache = { cwd, at: now, files };
  return files;
}

/**
 * 查找候选。
 *
 * @param cwd 工作目录
 * @param query @ 之后的字符串,可能含 `/` 表示逐级展开
 */
export async function queryAtCandidates(cwd: string, query: string): Promise<AtCandidate[]> {
  // 模式 1:query 含 `/` → 按目录展开
  if (query.includes("/")) {
    return listDir(cwd, query);
  }
  // 模式 2:扁平 fuzzy 全树
  const all = await loadAllFiles(cwd);
  return fuzzyFilter(all, query).slice(0, MAX_RESULTS);
}

async function listDir(cwd: string, query: string): Promise<AtCandidate[]> {
  // 拆 dir prefix + leaf query
  const lastSlash = query.lastIndexOf("/");
  const dirPart = query.slice(0, lastSlash);
  const leafQuery = query.slice(lastSlash + 1).toLowerCase();
  // dirPart 可能是 "" (`/` 开头 → cwd 根)或 "src/preprocess" 等
  const absDir = dirPart === "" || dirPart === "."
    ? cwd
    : resolve(cwd, dirPart.replace(/^\.\//, ""));
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  const out: AtCandidate[] = [];
  for (const name of entries) {
    if (leafQuery && !name.toLowerCase().includes(leafQuery)) continue;
    if (name === "node_modules" || name === ".git") continue;
    try {
      const info = await stat(join(absDir, name));
      const rel = dirPart === "" || dirPart === "." ? name : `${dirPart}/${name}`;
      out.push({ rel, isDir: info.isDirectory() });
    } catch {
      // skip
    }
  }
  // 排序:目录优先,然后字典序
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  return out.slice(0, MAX_RESULTS);
}

/**
 * 简单 fuzzy 匹配:子序列存在即命中,score 越小越好。
 * score = 首匹配位置 + 字符跨度;字典序作为 tie-breaker。
 */
function fuzzyFilter(all: AtCandidate[], query: string): AtCandidate[] {
  if (!query) {
    // 无 query → 返浅层目录优先(rel 中 `/` 越少越前),
    // 让用户敲 @ 就看到 cwd 顶层,符合常见的 @ 引用补全行为
    return all
      .slice()
      .sort((a, b) => {
        const depthDiff = depthOf(a.rel) - depthOf(b.rel);
        if (depthDiff !== 0) return depthDiff;
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.rel.localeCompare(b.rel);
      });
  }
  const q = query.toLowerCase();
  const scored: Array<{ c: AtCandidate; score: number }> = [];
  for (const c of all) {
    const base = basename(c.rel).toLowerCase();
    const full = c.rel.toLowerCase();
    // 基础名 starts-with 优先
    if (base.startsWith(q)) {
      scored.push({ c, score: 0 });
      continue;
    }
    if (base.includes(q)) {
      scored.push({ c, score: 10 + base.indexOf(q) });
      continue;
    }
    if (full.includes(q)) {
      scored.push({ c, score: 100 + full.indexOf(q) });
      continue;
    }
    // 子序列模糊
    const sub = subsequenceScore(full, q);
    if (sub >= 0) scored.push({ c, score: 1000 + sub });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.c.isDir !== b.c.isDir) return a.c.isDir ? -1 : 1;
    return a.c.rel.localeCompare(b.c.rel);
  });
  return scored.map((s) => s.c);
}

function depthOf(rel: string): number {
  let n = 0;
  for (const ch of rel) if (ch === "/") n++;
  return n;
}

function subsequenceScore(haystack: string, needle: string): number {
  let i = 0;
  let score = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      score += i; // 散度越大分越高
      i++;
      if (i === needle.length) return score;
    }
  }
  return -1;
}
