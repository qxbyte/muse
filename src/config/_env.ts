/**
 * ${ENV_VAR} 占位符递归展开。
 *
 * settings.json / models.local.json 都共用这套机制，避免把明文凭证落到可入 git 的文件。
 * 未定义的 env var → 空字符串（不抛错，让上层校验"必填字段是否非空"决定行为）。
 */

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return value;
}
