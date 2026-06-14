/**
 * @qxbyte/muse-plugin-sdk
 *
 * 给 muse plugin 作者的类型 + schema 契约。零运行期依赖(zod 为 peerDependency)。
 * 设计文档:模块设计/Plugins/设计.md §十。
 *
 * 与 muse 主包 `src/plugins/types.ts` 的公开契约保持一致(单一真相源在主包;
 * 本子包是面向作者的镜像,随主包 apiVersion 同步)。
 *
 * 用法(plugin 作者):
 *   import type { PluginContext, PluginRegisterFn } from "@qxbyte/muse-plugin-sdk";
 *   const register: PluginRegisterFn = (ctx) => {
 *     ctx.registerSlash({ name: "hello", description: "...", execute: () => ({ display: "hi" }) });
 *   };
 *   export default register;
 */

import { z } from "zod";

/** 与主包 PLUGIN_API_VERSION 对齐;manifest.apiVersion 必须等于宿主支持值。 */
export const PLUGIN_API_VERSION = "1" as const;

/** plugin manifest(`.muse-plugin/plugin.json`)schema。 */
export const PluginManifestSchema = z
  .object({
    apiVersion: z.string(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/).optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({ name: z.string(), email: z.string().optional(), url: z.string().optional() })
      .passthrough()
      .optional(),
    homepage: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    defaultEnabled: z.boolean().optional(),
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    mcpServers: z.union([z.string(), z.record(z.unknown())]).optional(),
    hooks: z.union([z.string(), z.record(z.unknown())]).optional(),
    main: z.string().optional(),
  })
  .passthrough();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** 作者侧 tool 形状(对应主包 AnyTool;execute 的精确签名以宿主为准)。 */
export interface PluginTool {
  name: string;
  description: string;
  parameters?: unknown;
  permission?: "read" | "write" | "execute" | "network";
  execute: (args: unknown, ctx: unknown) => unknown | Promise<unknown>;
  [k: string]: unknown;
}

/** 作者侧 slash command 形状(对应主包 SlashCommand)。 */
export interface PluginSlashCommand {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: string[];
  execute: (ctx: unknown) => unknown | Promise<unknown>;
}

export interface PluginLogger {
  trace(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/**
 * 暴露给 register 函数的能力集(capability passing)。
 * **不暴露** fs / env / child_process / network —— 外部能力请走 manifest mcpServers。
 * skills / mcpServers / hooks 走 manifest 声明,host 自动扫;register 只用于 tools / slash。
 */
export interface PluginContext {
  readonly plugin: { name: string; version: string; root: string; dataDir: string };
  registerTool(tool: PluginTool): void;
  registerSlash(cmd: PluginSlashCommand): void;
  /** v0.4:JS 函数 hook 暂无执行通路,请用 manifest hooks/hooks.json 声明。 */
  registerHook(point: string, hook: (input: Record<string, unknown>) => unknown): void;
  logger: PluginLogger;
}

export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>;
