/**
 * 敏感信息脱敏规则注册表。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §5.2。
 *
 * 与 src/tools/_sensitive.ts 并存不合并:
 *   - _sensitive.ts = 路径硬拦截(不让工具读 .ssh/ 等)
 *   - redact.ts     = 内容模式扫描(扫到的 API key / token 替换为 [REDACTED])
 */

export interface RedactRule {
  name: string;
  pattern: RegExp;
  /** 替换文本工厂(默认 [REDACTED:<name>])。 */
  replacement?: (match: string) => string;
}

export interface RedactResult {
  content: string;
  hits: Array<{ rule: string; count: number }>;
}

export const DEFAULT_RULES: RedactRule[] = [
  { name: "openai-key", pattern: /sk-[A-Za-z0-9]{32,}/g },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_\-]{32,}/g },
  { name: "github-pat", pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: "github-oauth", pattern: /gho_[A-Za-z0-9]{36}/g },
  { name: "github-app", pattern: /(?:ghu|ghs)_[A-Za-z0-9]{36}/g },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_\-]{35}/g },
  { name: "slack-token", pattern: /xox[bpars]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
];

export function redact(content: string, rules: ReadonlyArray<RedactRule> = DEFAULT_RULES): RedactResult {
  let out = content;
  const hits: Array<{ rule: string; count: number }> = [];
  for (const rule of rules) {
    let count = 0;
    out = out.replace(rule.pattern, (m) => {
      count++;
      return rule.replacement ? rule.replacement(m) : `[REDACTED:${rule.name}]`;
    });
    if (count > 0) hits.push({ rule: rule.name, count });
  }
  return { content: out, hits };
}
