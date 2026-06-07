/**
 * Hook 加载与执行。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §六。
 *
 * Hook 协议:外部 shell 命令 + stdin JSON / stdout JSON。
 * Hook 点位(MVP 只接 PreToolUse / PostToolUse,其余 schema 保留但不调用):
 *   SessionStart / SessionEnd / UserPromptSubmit /
 *   PreLLMRequest / PostLLMResponse /
 *   PreToolUse / PostToolUse /
 *   PreCompact / PostCompact
 */

import { execa } from "execa";
import { NOOP_LOGGER, type PreprocessLogger } from "./types.js";
import { PipelineBlockedError } from "./pipeline.js";

export type HookPoint =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreLLMRequest"
  | "PostLLMResponse"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "MemoryPromote";

export interface HookSpec {
  /** 工具名 / 路径前缀的正则匹配字符串(不含 /);"" 或缺省视为全匹配 .* 。 */
  matcher?: string;
  /** 绝对路径或 PATH 可解析命令;**禁用 shell 元字符**。 */
  command: string;
  /** 毫秒,默认 30000,上限 60000。 */
  timeout?: number;
  /** "skip"(默认)记 warn 后继续 / "throw" 命中即 abort 当前 turn。 */
  onError?: "skip" | "throw";
}

export interface HooksConfig {
  SessionStart?: HookSpec[];
  SessionEnd?: HookSpec[];
  UserPromptSubmit?: HookSpec[];
  PreLLMRequest?: HookSpec[];
  PostLLMResponse?: HookSpec[];
  PreToolUse?: HookSpec[];
  PostToolUse?: HookSpec[];
  PreCompact?: HookSpec[];
  PostCompact?: HookSpec[];
  /** I-5:compactMessages 在 promote 每条 fact 到 memory 之前调用;可 block 该条。 */
  MemoryPromote?: HookSpec[];
}

export interface HookOutput {
  /** 由 hook 返回的字段,会与原 input merge(具体字段由点位定义)。 */
  [k: string]: unknown;
  block?: { reason: string };
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 60_000;
const SHELL_META = /[;|&><`$()]/;

/**
 * 跑同点位的全部 hooks(串行链式)。返回最终 merged 输出。
 *
 * - 任一 hook 返回 block → 立即抛 PipelineBlockedError
 * - hook 进程非 0 退出 / 超时 / stdout 非 JSON → 按 onError 处理
 *
 * MVP 期间只在 PreToolUse / PostToolUse 调用;其它点位 schema 保留,不接代码。
 */
export async function runHooks(
  point: HookPoint,
  input: Record<string, unknown>,
  hooks: HooksConfig | undefined,
  logger: PreprocessLogger = NOOP_LOGGER,
): Promise<HookOutput> {
  const specs = hooks?.[point];
  if (!specs || specs.length === 0) return {};

  let merged: HookOutput = {};
  let payload: Record<string, unknown> = { ...input };

  const matcherKey = pickMatcherKey(input);

  for (const spec of specs) {
    if (!matchesMatcher(spec.matcher, payload, matcherKey)) continue;
    if (SHELL_META.test(spec.command)) {
      logger.warn(`hook:${point}`, `command rejected: contains shell metachar`, { command: spec.command });
      continue;
    }
    const timeout = Math.min(spec.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    try {
      const result = await execa(spec.command, [], {
        input: JSON.stringify(payload),
        timeout,
        reject: false,
        env: hookEnv(),
      });
      if (result.failed) {
        const reason = `exit ${result.exitCode ?? "?"} / signal ${result.signal ?? ""}`;
        handleHookError(point, spec, reason, logger);
        continue;
      }
      const text = (result.stdout ?? "").trim();
      if (!text) continue;
      let out: HookOutput;
      try {
        out = JSON.parse(text) as HookOutput;
      } catch (err) {
        handleHookError(point, spec, `stdout not JSON: ${(err as Error).message}`, logger);
        continue;
      }
      if (out?.block && typeof out.block === "object" && typeof out.block.reason === "string") {
        throw new PipelineBlockedError(point, out.block.reason);
      }
      merged = { ...merged, ...out };
      // 链式:下一 hook 看见上一个 hook 改写后的值
      payload = { ...payload, ...out };
    } catch (err) {
      if (err instanceof PipelineBlockedError) throw err;
      handleHookError(point, spec, (err as Error).message, logger);
    }
  }
  return merged;
}

function handleHookError(point: HookPoint, spec: HookSpec, reason: string, logger: PreprocessLogger): void {
  const onError = spec.onError ?? "skip";
  logger.warn(`hook:${point}`, reason, { command: spec.command, onError });
  if (onError === "throw") {
    throw new Error(`hook ${point} failed: ${reason}`);
  }
}

/** 输入哪个字段作 matcher 比较:PreToolUse/PostToolUse 用 toolName,其余按 stage 自身约定。 */
function pickMatcherKey(input: Record<string, unknown>): string | undefined {
  if (typeof input.toolName === "string") return "toolName";
  if (typeof input.path === "string") return "path";
  return undefined;
}

function matchesMatcher(matcher: string | undefined, payload: Record<string, unknown>, key: string | undefined): boolean {
  if (!matcher || matcher === ".*") return true;
  if (!key) return true;
  const value = payload[key];
  if (typeof value !== "string") return true;
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

/** Hook 子进程的环境变量白名单(避免泄露 MUSE_ACTIVE_API_KEY 等密钥)。 */
function hookEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}
