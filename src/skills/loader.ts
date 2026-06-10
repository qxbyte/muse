/**
 * Skills loader:扫两层目录(personal + project),解析,构建 SkillRegistry。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.3 / §五.5。
 *
 * 作用域规则:
 *   personal  ~/.muse/skills/<name>/SKILL.md      跨项目用户级
 *   project   <cwd>/.muse/skills/<name>/SKILL.md  项目级,可入 git 团队共享
 *
 * 冲突规则:**project 覆盖 personal**(对齐 Codex CLI 共识)。
 *
 * 错误兜底:
 *   - 单个 SKILL.md 解析失败 → 跳过 + 错误进 SkillLoadResult.errors,不阻塞启动
 *   - 目录不存在 → 视作 0 skill,无错误
 *   - settings.skills.disabled 列出的 name 跳过(personal + project 都跳)
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSkillFile } from "./parser.js";
import type {
  SkillFile,
  SkillLoadError,
  SkillLoadResult,
  SkillRegistry,
  SkillScope,
} from "./types.js";

export interface LoadSkillsOpts {
  /** 默认 ~/.muse/skills。 */
  personalDir?: string;
  /** 默认 <cwd>/.muse/skills。 */
  projectDir?: string;
  /** settings.skills.disabled — 黑名单。 */
  disabled?: string[];
}

export async function loadSkills(cwd: string, opts: LoadSkillsOpts = {}): Promise<SkillLoadResult> {
  const personalDir = opts.personalDir ?? defaultPersonalDir();
  const projectDir = opts.projectDir ?? defaultProjectDir(cwd);
  const disabled = new Set(opts.disabled ?? []);
  const errors: SkillLoadError[] = [];
  const skills = new Map<string, SkillFile>();

  // 先扫 personal(可被 project 覆盖)
  for (const file of await scanScopeDir(personalDir, "personal", errors)) {
    if (disabled.has(file.name)) continue;
    skills.set(file.name, file);
  }
  // 再扫 project,同名覆盖
  for (const file of await scanScopeDir(projectDir, "project", errors)) {
    if (disabled.has(file.name)) continue;
    skills.set(file.name, file);
  }

  return { registry: makeRegistry([...skills.values()]), errors };
}

export function defaultPersonalDir(): string {
  return join(homedir(), ".muse", "skills");
}

export function defaultProjectDir(cwd: string): string {
  return resolve(cwd, ".muse", "skills");
}

/** 扫一层 scope 目录 → 返回成功解析的 SkillFile;解析失败的进 errors。 */
async function scanScopeDir(dir: string, scope: SkillScope, errors: SkillLoadError[]): Promise<SkillFile[]> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    errors.push({ path: dir, reason: `readdir failed: ${(err as Error).message}` });
    return [];
  }
  const out: SkillFile[] = [];
  for (const entry of entries) {
    const dirPath = join(dir, entry);
    const filePath = join(dirPath, "SKILL.md");
    if (!(await isSkillDir(dirPath, filePath))) continue;
    try {
      const raw = await readFile(filePath, "utf-8");
      const { frontmatter, body } = parseSkillFile(raw);
      out.push({ name: frontmatter.name, frontmatter, body, filePath, dirPath, scope });
    } catch (err) {
      errors.push({ path: filePath, reason: (err as Error).message });
    }
  }
  return out;
}

/** entry 是目录 + 含 SKILL.md → 是 skill 目录。 */
async function isSkillDir(dirPath: string, filePath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(filePath);
}

function makeRegistry(files: SkillFile[]): SkillRegistry {
  const byName = new Map(files.map((f) => [f.name, f]));
  return {
    list: () => [...files],
    get: (name) => byName.get(name),
    listInvocable: () => files.filter((f) => !f.frontmatter["disable-model-invocation"]),
    size: () => files.length,
  };
}
