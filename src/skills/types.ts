/**
 * Skills 类型定义。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五。
 *
 * SKILL.md = frontmatter(yaml-ish)+ markdown body。
 * 业界共识:Claude Code skills + Codex CLI Agent Skills 同源开放标准。
 */

import { z } from "zod";

/** SKILL.md frontmatter 的 zod schema(单一真值)。 */
export const SkillFrontmatterSchema = z.object({
  /** 文件 slug;kebab/snake case,与目录名一致(但以 frontmatter 为准)。 */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "name must be kebab/snake-case alphanumeric, lowercase, start with letter/digit"),
  /** LLM 自决依据,短而明确(10-600 字)。 */
  description: z.string().min(10).max(600),
  /**
   * 工具白名单;不写 = 任意可用工具都可调。
   * 写了 → skill 激活期间 PermissionGate 只放行此列表内的工具
   *(plan 模式仍叠加 read-only 过滤,**取交集**)。
   */
  "allowed-tools": z.array(z.string()).optional(),
  /**
   * true → 不进 system-prompt 的 "Available skills" 段,LLM 看不到。
   * 仅能通过 `/skill run <name>` 显式触发。
   * 用于敏感操作(deploy / migration / destructive)。
   */
  "disable-model-invocation": z.boolean().optional(),
  /** 触发关键词;与 description 一起决定 LLM 自决匹配权重(本期实装暂不用,留 v0.3.x)。 */
  triggers: z.array(z.string()).optional(),
  /**
   * 自动挂载 glob(扩展接入口 §十 v0.3.x;对齐 Cursor auto-attached rules)。
   * 写了 → 该 skill 仅当 cwd 内存在匹配 glob 的文件时才进 "Available skills" 段(供 LLM 自决);
   * 不写 → 永远在 Available skills(现行为)。
   * 无论是否挂载,`/skill run` 与 `@skill` 显式触发都不受影响。
   * glob 相对项目 cwd,如匹配 Terraform 文件(双星斜杠星点 tf)或 ["Dockerfile"]。
   */
  globs: z.array(z.string()).optional(),
}).passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export type SkillScope = "personal" | "project";

/** 解析后的 SKILL.md。 */
export interface SkillFile {
  name: string;
  frontmatter: SkillFrontmatter;
  /** markdown body(frontmatter 之后的内容),不含开头空行。 */
  body: string;
  /** SKILL.md 绝对路径。 */
  filePath: string;
  /** skill 目录绝对路径(SKILL.md 所在目录;可放 scripts/ templates/ 等辅助文件)。 */
  dirPath: string;
  scope: SkillScope;
  /**
   * 是否自动挂载(扩展接入口 §十)。loader 加载期按 frontmatter.globs 对 cwd 求值:
   *   - 无 globs → true(永远进 Available skills)
   *   - 有 globs 且 cwd 命中 → true;未命中 → false(从 Available skills 隐藏)
   * undefined 视同 true(向后兼容未经 glob 求值的 SkillFile)。
   */
  mounted?: boolean;
}

/** SkillRegistry 对外接口(immutable 视图)。 */
export interface SkillRegistry {
  list(): SkillFile[];
  get(name: string): SkillFile | undefined;
  /** 返回 LLM 自决候选(过滤 disable-model-invocation=true)。 */
  listInvocable(): SkillFile[];
  /** 数量(给 status / debug 用)。 */
  size(): number;
}

/**
 * 解析失败的记录(不入 registry,启动期 stderr 显示)。
 * loader.ts 把 fatal 错误统一通过此结构上报,不抛异常阻塞启动。
 */
export interface SkillLoadError {
  path: string;
  reason: string;
}

export interface SkillLoadResult {
  registry: SkillRegistry;
  errors: SkillLoadError[];
}
