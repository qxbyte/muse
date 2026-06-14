/**
 * Marketplace 解析:marketplace.json + source 规范化。
 *
 * 设计文档:模块设计/Plugins/设计.md §四。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import {
  MarketplaceManifestSchema,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceSource,
} from "./types.js";

/** marketplace manifest 在 clone 内的相对路径。 */
export const MARKETPLACE_MANIFEST_REL = join(".muse-plugin", "marketplace.json");

/** 解析 marketplace.json 文本/对象 → 校验;失败抛错(由调用方兜底)。 */
export function parseMarketplaceManifest(raw: string | unknown): MarketplaceManifest {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  const parsed = MarketplaceManifestSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(`invalid marketplace.json: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** 从 marketplace 目录读 `.muse-plugin/marketplace.json`。 */
export function loadMarketplaceManifest(marketplaceDir: string): MarketplaceManifest {
  const file = join(marketplaceDir, MARKETPLACE_MANIFEST_REL);
  if (!existsSync(file)) {
    throw new Error(`marketplace.json not found at ${file}`);
  }
  return parseMarketplaceManifest(readFileSync(file, "utf-8"));
}

/** 在 manifest 里找 plugin 条目。 */
export function findPluginEntry(
  manifest: MarketplaceManifest,
  pluginName: string,
): MarketplacePluginEntry | undefined {
  return manifest.plugins.find((p) => p.name === pluginName);
}

/**
 * 把 `/plugin marketplace add <input>` 的字符串规范化为 MarketplaceSource 对象。
 *   - 已是对象 → 原样
 *   - `owner/repo` / `owner/repo@ref` → github
 *   - `http(s)://…(.git)` / `git@…` / `…#ref` → url
 *   - `./` `../` `/` `~` 开头或本地存在的目录 → local
 */
export function normalizeMarketplaceSource(input: string | MarketplaceSource): MarketplaceSource {
  if (typeof input !== "string") return input;
  const s = input.trim();

  // 本地路径
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.startsWith("~")) {
    return { source: "local", path: s };
  }
  // git url(http/https/git@/ssh),支持 #ref
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(s) || s.endsWith(".git")) {
    const hashIdx = s.indexOf("#");
    if (hashIdx >= 0) {
      return { source: "url", url: s.slice(0, hashIdx), ref: s.slice(hashIdx + 1) };
    }
    return { source: "url", url: s };
  }
  // owner/repo 或 owner/repo@ref → github
  const ghMatch = s.match(/^([\w.-]+\/[\w.-]+)(?:@(.+))?$/);
  if (ghMatch) {
    return { source: "github", repo: ghMatch[1], ...(ghMatch[2] ? { ref: ghMatch[2] } : {}) };
  }
  // 兜底:本地存在的目录视作 local,否则报错
  if (existsSync(s)) return { source: "local", path: s };
  throw new Error(`cannot resolve marketplace source: "${input}"`);
}

/**
 * marketplace 内联(相对路径)plugin 的源目录解析:相对 marketplace clone 根。
 * 受 metadata.pluginRoot 影响(若 source 为相对路径)。返回绝对路径。
 * source 非相对(github/url)→ 返回 null(需走 fetch clone,留 PI-4)。
 */
export function resolveInlinePluginDir(
  manifest: MarketplaceManifest,
  entry: MarketplacePluginEntry,
  marketplaceDir: string,
): string | null {
  if (typeof entry.source !== "string") return null;
  const base = manifest.metadata?.pluginRoot
    ? resolve(marketplaceDir, manifest.metadata.pluginRoot)
    : marketplaceDir;
  const dir = isAbsolute(entry.source) ? entry.source : resolve(base, entry.source);
  return dir;
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
