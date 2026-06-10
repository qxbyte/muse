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
  /** LLM 自决依据,短而明确(10-400 字)。 */
  description: z.string().min(10).max(400),
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
