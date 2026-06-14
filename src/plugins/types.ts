/**
 * Plugins 模块类型骨架(P1)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §六。
 *
 * 范围声明(本期 v0.3 仅落骨架):
 *   - ✅ manifest schema(plugin 包 package.json 的 `muse` 字段)
 *   - ✅ settings.plugins schema(显式 opt-in enable list)
 *   - ✅ PluginContext / register 入口的类型契约(capability passing 安全模型)
 *   - ❌ loader / dynamic import / activationEvents 引擎    → v0.4
 *   - ❌ @qxbyte/muse-plugin-sdk 子包发布                  → v0.4
 *   - ❌ /plugin slash(list / install / disable / enable) → v0.4
 *
 * Plugin = packaging unit:把 N skills + M mcpServers + K hooks + 内置 tools
 * 打包成一个 npm 包。加载时调 host 提供的 register API 把扩展元素注册到现有
 * ToolRegistry / SkillRegistry / mcpServers map / HooksConfig,自身不持运行期状态。
 */

import { z } from "zod";
import type { AnyTool } from "../tools/types.js";
import type { SlashCommand } from "../slash/types.js";
import type { HookPoint } from "../preprocess/hooks.js";

/**
 * 主包 API 兼容标记。plugin manifest 的 `muse.apiVersion` 必须匹配此值,
 * 否则 loader 拒载(v0.4 落地)。bump 规则:host 暴露给 plugin 的 register
 * API 出现破坏性变更时 +1。
 */
export const PLUGIN_API_VERSION = "1" as const;

/**
 * `settings.plugins`(设计 §八)。
 *
 * 显式 opt-in:即使 `npm i` 装了 plugin,不在 `enabled` 列表也不加载
 * (对齐 Cline / Continue 共识 — 不自动发现)。
 *
 * 本期仅校验 schema,不接 loader。
 */
export const PluginsConfigSchema = z.object({
  /** 启用的 plugin 包名列表(npm package name)。 */
  enabled: z.array(z.string()).optional(),
}).passthrough();

export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

/**
 * Plugin 包 package.json 的 `muse` 字段(设计 §6.3)。
 *
 * skills / mcpServers 在 manifest 声明,host 自动扫;register 主入口只用来
 * 注册 tools / slash / hooks(skills 与 mcpServers 不必触碰主代码)。
 */
export const PluginManifestSchema = z.object({
  /** 主包 semver 兼容标记;不匹配 PLUGIN_API_VERSION → 拒载。 */
  apiVersion: z.string(),
  /** dynamic import 入口(默认回退 package.json "main")。 */
  main: z.string().optional(),
  /** glob,声明此 plugin 提供哪些 skills(相对 plugin 包根)。 */
  skills: z.array(z.string()).optional(),
  /** 此 plugin 内嵌的 MCP server 配置(与 settings.mcpServers 合并)。 */
  mcpServers: z.record(z.unknown()).optional(),
  /** 对齐 VSCode contributes 模式;命中才 dynamic import register fn(lazy)。 */
  activationEvents: z.array(z.string()).optional(),
}).passthrough();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * 暴露给 plugin register 函数的能力集(capability passing,设计 §6.5)。
 *
 * **刻意不暴露** process.env / fs / child_process / network — plugin 要执行
 * 外部能力必须走 manifest 声明的 MCP server(子进程隔离)。这是安全模型的核心:
 * plugin 主代码只能注册声明式扩展,不能直接触碰宿主资源。
 */
export interface PluginContext {
  registerTool(tool: AnyTool): void;
  registerSlash(cmd: SlashCommand): void;
  registerHook(point: HookPoint, hook: PluginHookFn): void;
  logger: PluginLogger;
}

/**
 * plugin 注册的 hook 回调。签名与 host 内部 hook 执行对齐(stdin JSON → stdout JSON),
 * 但 plugin 直接给 JS 函数而非外部 shell 命令。完整执行语义留 v0.4。
 */
export type PluginHookFn = (
  input: Record<string, unknown>,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

/**
 * plugin 主入口签名(由 manifest `main` 指向的模块 default export,设计 §6.4)。
 *
 *   export default function register(ctx: PluginContext) { ... }
 */
export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>;

/**
 * 给 plugin 的最小日志接口(结构子集,避免 plugin 依赖 host 内部 Logger 类)。
 */
export interface PluginLogger {
  trace(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}
