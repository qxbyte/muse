/**
 * SKILL.md 解析:frontmatter(yaml-ish)+ markdown body。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.1 / §五.2。
 *
 * 故意不引第三方 yaml 库 — frontmatter 字段规整、嵌套浅;手解析够用且与
 * src/loop/memory.ts 的 memory frontmatter 风格一致(单一 parser 风格)。
 *
 * 支持的 frontmatter 字段(对应 SkillFrontmatterSchema):
 *   name: deploy-prod
 *   description: deploy current branch to prod
 *   allowed-tools: [Bash, Read]        # 行内 JSON-style array
 *   disable-model-invocation: true
 *   triggers: ["ship", "release"]
 */

import { SkillFrontmatterSchema, type SkillFrontmatter } from "./types.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** 解析 SKILL.md 全文 → frontmatter + body;失败抛错(由 loader 兜底)。 */
export function parseSkillFile(raw: string): ParsedSkill {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error("missing frontmatter (--- ... --- block at file start)");
  }
  const rawFm = parseYamlIshBlock(m[1]);
  const parsed = SkillFrontmatterSchema.safeParse(rawFm);
  if (!parsed.success) {
    throw new Error(`frontmatter invalid: ${formatZodIssues(parsed.error.issues)}`);
  }
  const body = raw.slice(m[0].length).trim();
  return { frontmatter: parsed.data, body };
}

/**
 * 极简 yaml-ish 解析:
 *   - 顶层 `key: value` 一行
 *   - value 是 `[a, b, c]` → array<string>
 *   - value 是 `true|false` → boolean
 *   - 其他 → string(去引号)
 *
 * 不支持嵌套对象、多行字符串、引用锚点;够 SKILL.md 用,且解析行为可预测。
 */
function parseYamlIshBlock(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kv = parseKVLine(trimmed);
    if (kv) out[kv.key] = kv.value;
  }
  return out;
}

function parseKVLine(line: string): { key: string; value: unknown } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const key = line.slice(0, idx).trim();
  const rawValue = line.slice(idx + 1).trim();
  if (!key) return null;
  return { key, value: coerceValue(rawValue) };
}

function coerceValue(raw: string): unknown {
  if (!raw) return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return parseInlineArray(raw);
  }
  return stripQuotes(raw);
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
