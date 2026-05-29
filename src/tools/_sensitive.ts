/**
 * 敏感文件路径默认 deny。设计文档 §12.3。
 *
 * 工具层做硬拦截（不通过 PermissionGate）。即使 settings.permissions.allow 加了 Read/Write，
 * 这层也兜底；用户要绕过必须在 PermissionGate 之外显式同意（v1.0 才考虑）。
 *
 * 规则：
 *   - ~/.ssh           （SSH 私钥 / known_hosts）
 *   - ~/.aws           （AWS 凭证）
 *   - ~/.gnupg         （GPG 私钥）
 *   - ~/.kube/config   （集群 token）
 *   - .env / .env.*    （任何位置的环境文件）
 *   - id_rsa / id_ed25519 等私钥文件名
 */

import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const HOME = homedir();
const SENSITIVE_DIRS = [
  resolve(HOME, ".ssh"),
  resolve(HOME, ".aws"),
  resolve(HOME, ".gnupg"),
  resolve(HOME, ".config", "gh"),
];
const SENSITIVE_FILES = [
  resolve(HOME, ".kube", "config"),
  resolve(HOME, ".netrc"),
  resolve(HOME, ".pypirc"),
];
const SENSITIVE_BASENAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);
const ENV_PATTERN = /(?:^|\/)\.env(\..+)?$/;

export interface SensitiveCheck {
  blocked: boolean;
  reason?: string;
}

export function checkSensitivePath(path: string): SensitiveCheck {
  const abs = resolve(path);
  for (const dir of SENSITIVE_DIRS) {
    if (abs === dir || abs.startsWith(dir + "/")) {
      return { blocked: true, reason: `sensitive directory ${dir.replace(HOME, "~")}` };
    }
  }
  for (const f of SENSITIVE_FILES) {
    if (abs === f) return { blocked: true, reason: `sensitive file ${f.replace(HOME, "~")}` };
  }
  const base = basename(abs);
  if (SENSITIVE_BASENAMES.has(base)) {
    return { blocked: true, reason: `private key filename ${base}` };
  }
  if (ENV_PATTERN.test(abs)) {
    return { blocked: true, reason: `.env file (may contain secrets)` };
  }
  return { blocked: false };
}
