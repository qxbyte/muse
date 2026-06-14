/**
 * 抓取 marketplace / plugin 到本地缓存。
 *
 * 设计文档:模块设计/Plugins/设计.md §五。
 *
 * - local source:递归复制目录。
 * - github / url source:`git clone --depth 1`(可选 ref)。私有 repo 走环境里的
 *   git 凭据(沿用现有 env;不在此管 token)。
 *
 * 本期单测只覆盖 local 复制;git clone 逻辑实现但靠集成/人工验证(避免网络依赖)。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import { resolveInlinePluginDir } from "./marketplace.js";
import type { MarketplaceManifest, MarketplacePluginEntry, MarketplaceSource } from "./types.js";

function expandTilde(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

/** 递归复制目录到 dest(先清空 dest)。 */
export function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`source dir not found: ${src}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/** git 浅克隆(可选 ref);失败抛错。 */
export async function gitClone(url: string, dest: string, ref?: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, dest];
  await execa("git", args, { stdio: "pipe" });
}

/** 把 marketplace source 抓到 destDir(用于 /plugin marketplace add)。 */
export async function fetchMarketplace(source: MarketplaceSource, destDir: string): Promise<void> {
  if (typeof source === "string") {
    throw new Error("fetchMarketplace expects a normalized source object");
  }
  switch (source.source) {
    case "local":
      copyDir(resolve(expandTilde(source.path ?? "")), destDir);
      return;
    case "github":
      await gitClone(`https://github.com/${source.repo}.git`, destDir, source.ref);
      return;
    case "url":
      await gitClone(source.url ?? "", destDir, source.ref);
      return;
    default:
      throw new Error(`unsupported marketplace source: ${(source as { source?: string }).source}`);
  }
}

/**
 * 把 plugin 抓到缓存版本目录(用于 /plugin install)。
 *   - 内联(相对路径)→ 从 marketplace clone 复制
 *   - github / url → git clone
 */
export async function fetchPlugin(opts: {
  entry: MarketplacePluginEntry;
  manifest: MarketplaceManifest;
  marketplaceDir: string;
  destVersionDir: string;
}): Promise<void> {
  const { entry, manifest, marketplaceDir, destVersionDir } = opts;
  if (typeof entry.source === "string") {
    const dir = resolveInlinePluginDir(manifest, entry, marketplaceDir);
    if (!dir || !existsSync(dir)) {
      throw new Error(`inline plugin source not found: ${entry.source}`);
    }
    copyDir(dir, destVersionDir);
    return;
  }
  if (entry.source.source === "github") {
    await gitClone(`https://github.com/${entry.source.repo}.git`, destVersionDir, entry.source.ref);
    return;
  }
  if (entry.source.source === "url") {
    await gitClone(entry.source.url ?? "", destVersionDir, entry.source.ref);
    return;
  }
  throw new Error(`unsupported plugin source: ${JSON.stringify(entry.source)}`);
}
