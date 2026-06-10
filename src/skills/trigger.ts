/**
 * Skills 触发监听:扫 LLM 输出 text 找已注册的 skill name(整词 case-insensitive)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7.1。
 *
 * 不做语义匹配 / embedding;描述触发率高但误触发可接受 — 业界共识(Claude Code 同款简单匹配)。
 * 已激活的 skill 不再重复触发(用 activeSet 去重)。
 */

import type { SkillFile, SkillRegistry } from "./types.js";

/**
 * 扫一段 LLM 输出 text,返回**首次**被命中的 skill 列表。
 *
 * - 仅匹配 invocable(disable-model-invocation=false)的 skill
 * - activeSet 内已激活的 skill 跳过(不重复注入 body)
 * - 整词匹配(\b...\b);name 含非 word 字符时退化为普通 indexOf
 */
export function detectSkillTriggers(
  text: string,
  registry: SkillRegistry,
  activeSet: Set<string>,
): SkillFile[] {
  if (!text) return [];
  const triggered: SkillFile[] = [];
  for (const s of registry.listInvocable()) {
    if (activeSet.has(s.name)) continue;
    if (matchSkillName(text, s.name)) triggered.push(s);
  }
  return triggered;
}

function matchSkillName(text: string, name: string): boolean {
  // 安全:name 已 zod 校验为 kebab/snake-case alphanumeric,正则字符无需 escape
  // 但保险起见仍走 escape — 防未来 schema 放宽时此处失守。
  const escaped = escapeRegex(name);
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
