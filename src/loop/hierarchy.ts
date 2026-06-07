/**
 * 项目级配置文件 hierarchy 加载(MUSE.md + AGENTS.md)。
 *
 * 设计文档:模块设计/Agent 记忆系统/设计.md §4.1。
 *
 * 5 层(低到高优先级):
 *   1. managed  /etc/muse/MUSE.md             企业 IT 部署(本期占位,只读不写)
 *   2. user     ~/.muse/MUSE.md               跨项目偏好
 *   3. project  <root>/MUSE.md 或 AGENTS.md   团队共享(入 git);两者并存时 overlay(MUSE.md 优先)
 *   4. local    <root>/.muse/MUSE.local.md    个人本地(不入 git)
 *   5. subdir   <root>/<subdir>/MUSE.md       子目录上下文(惰性加载,下一阶段实装)
 *
 * 注入点:RequestPipeline.build-system-prompt 把前 4 层拼到 systemPrompt 头部。
 * 子目录(第 5 层)在 Agent loop 检测到文件路径触及未加载子目录时主动注入到 tool result prefix。
 *
 * projectRoot 识别:从 cwd 向上找 `.git` 或 `.muse`;找不到则用 cwd 本身。
 * 与 config loader(只用 cwd)略有差异,因为 hierarchy 文件通常落项目根,
 * 子目录跑 muse 也应能找到。
 */

import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type HierarchyLevel = "managed" | "user" | "project" | "local" | "subdir";
export type HierarchySource = "MUSE.md" | "AGENTS.md";

export interface HierarchyLayer {
  level: HierarchyLevel;
  path: string;
  content: string;
  source: HierarchySource;
  /** hierarchy 来源永远 trusted(对齐设计 §4.4)。 */
  trust: "trusted";
}

export interface LoadHierarchyOpts {
  /** 启用 managed 层(读 /etc/muse/MUSE.md)。默认 false(本期占位)。 */
  enableManaged?: boolean;
  /** Managed 层路径覆盖(便于测试 / 自定义部署)。默认 /etc/muse/MUSE.md。 */
  managedPath?: string;
  /** 忽略 AGENTS.md(只读 MUSE.md)。默认 false。 */
  ignoreAgentsMd?: boolean;
}

const DEFAULT_MANAGED_PATH = "/etc/muse/MUSE.md";

/**
 * 从 cwd 向上找到第一个含 `.git` 或 `.muse` 的目录作为 project root。找不到则用 cwd。
 *
 * 用于 hierarchy 查找的项目层根目录,与 memory/projects/<hash>/ 的 cwd 隔离逻辑无关
 * (后者保留按 cwd 隔离,避免动既有 session/memory 数据)。
 */
export function findProjectRoot(cwd: string): string {
  let cur = resolve(cwd);
  while (true) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, ".muse"))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) return resolve(cwd); // 到根没找到 — 回退 cwd
    cur = parent;
  }
}

/**
 * 加载前 4 层 hierarchy。子目录(第 5 层)由独立函数 loadSubdirMemory 在 Agent loop 触发。
 *
 * 行为:
 *   - 每一层文件不存在 → skip(无副作用)
 *   - project 层 MUSE.md + AGENTS.md 并存 → 两条 layer(MUSE.md 在前)
 *   - 读取失败 → skip 该 layer,不抛错
 */
export async function loadHierarchy(cwd: string, opts: LoadHierarchyOpts = {}): Promise<HierarchyLayer[]> {
  const layers: HierarchyLayer[] = [];
  const ignoreAgents = opts.ignoreAgentsMd === true;

  // 1. managed(占位 — 默认 false)
  if (opts.enableManaged === true) {
    const path = opts.managedPath ?? DEFAULT_MANAGED_PATH;
    const layer = await tryLoadLayer("managed", path, "MUSE.md");
    if (layer) layers.push(layer);
  }

  // 2. user
  const userPath = join(homedir(), ".muse", "MUSE.md");
  const userLayer = await tryLoadLayer("user", userPath, "MUSE.md");
  if (userLayer) layers.push(userLayer);

  // 3. project — MUSE.md 优先,AGENTS.md 备份;两者并存时各推一条
  const root = findProjectRoot(cwd);
  const projectMuse = await tryLoadLayer("project", join(root, "MUSE.md"), "MUSE.md");
  if (projectMuse) layers.push(projectMuse);
  if (!ignoreAgents) {
    const projectAgents = await tryLoadLayer("project", join(root, "AGENTS.md"), "AGENTS.md");
    if (projectAgents) layers.push(projectAgents);
  }

  // 4. local
  const localPath = join(root, ".muse", "MUSE.local.md");
  const localLayer = await tryLoadLayer("local", localPath, "MUSE.md");
  if (localLayer) layers.push(localLayer);

  return layers;
}

async function tryLoadLayer(
  level: HierarchyLevel,
  path: string,
  source: HierarchySource,
): Promise<HierarchyLayer | null> {
  if (!existsSync(path)) return null;
  try {
    const content = (await readFile(path, "utf-8")).trim();
    if (!content) return null;
    return { level, path, content, source, trust: "trusted" };
  } catch {
    return null;
  }
}

/**
 * 把多个 layer 拼成 system prompt 的 hierarchy 段。各层之间用 `---` 分隔,标注来源。
 *
 * 输出格式:
 *   # Project guidance (hierarchy)
 *
 *   [user: ~/.muse/MUSE.md]
 *   ...
 *
 *   ---
 *
 *   [project: ./MUSE.md]
 *   ...
 */
export function formatHierarchyForPrompt(layers: HierarchyLayer[]): string {
  if (layers.length === 0) return "";
  const sections = layers.map((l) => `[${l.level}: ${prettyPath(l.path)}]\n${l.content}`);
  return `# Project guidance (hierarchy)\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * 子目录惰性加载入口。给 Agent loop 用:每跑完一个工具,检测工具操作的路径是否进入了
 * 未加载过的子目录;若该子目录含 MUSE.md / AGENTS.md → 返回内容附加到 tool result prefix。
 *
 * 单次调用只读一个子目录;去重逻辑由调用方维护(用绝对路径 Set)。
 */
export async function loadSubdirMemory(
  absSubdir: string,
  opts: { ignoreAgentsMd?: boolean; sizeCapBytes?: number } = {},
): Promise<{ content: string; source: HierarchySource; truncated: boolean } | null> {
  const sizeCap = opts.sizeCapBytes ?? 5120;
  // MUSE.md 优先,AGENTS.md 备份
  const candidates: { path: string; source: HierarchySource }[] = [
    { path: join(absSubdir, "MUSE.md"), source: "MUSE.md" },
  ];
  if (opts.ignoreAgentsMd !== true) {
    candidates.push({ path: join(absSubdir, "AGENTS.md"), source: "AGENTS.md" });
  }
  for (const { path, source } of candidates) {
    if (!existsSync(path)) continue;
    try {
      let raw = (await readFile(path, "utf-8")).trim();
      if (!raw) continue;
      const truncated = raw.length > sizeCap;
      if (truncated) {
        raw = raw.slice(0, sizeCap) + `\n\n[... truncated (over ${sizeCap}B; use Read tool to view full file)]`;
      }
      return { content: raw, source, truncated };
    } catch {
      // 单文件失败 → 试下一个 candidate
    }
  }
  return null;
}

function prettyPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/** 加载日志辅助:供 --debug 输出 hierarchy 加载情况。 */
export function describeLayers(layers: HierarchyLayer[]): string {
  if (layers.length === 0) return "(no hierarchy files found)";
  return layers
    .map((l) => {
      let size = 0;
      try {
        size = statSync(l.path).size;
      } catch {}
      return `[${l.level}] ${prettyPath(l.path)} (${size}B, ${l.source})`;
    })
    .join("\n");
}
