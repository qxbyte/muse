/**
 * Plugins 模块类型(v0.4)。
 *
 * 设计文档:模块设计/Plugins/设计.md(承接 扩展接入口/设计.md §六 P1 骨架)。
 *
 * Plugin = packaging unit:把 N skills + M mcpServers + K hooks + slash commands
 * (+ 可选 tools)打包成可分发单元(git repo / 本地目录)。加载时调 host register API
 * 注册到现有 ToolRegistry / SkillRegistry / mcpServers / HooksConfig,自身不持运行期状态。
 *
 * Marketplace = catalog:plugin 之上的目录层(marketplace.json),声明有哪些 plugin、各从哪取。
 *
 * 取代 P1:settings 由 `plugins.enabled[]` 改为 `extraKnownMarketplaces` + `enabledPlugins`
 * (对齐 Claude Code);manifest 由 package.json `muse` 字段改为 `.muse-plugin/plugin.json`;
 * 去掉 activationEvents(改启动期全量加载)。
 */

import { z } from "zod";
import type { AnyTool } from "../tools/types.js";
import type { SlashCommand } from "../slash/types.js";
import type { HookPoint } from "../preprocess/hooks.js";

/**
 * 主包 API 兼容标记。plugin manifest 的 `apiVersion` 必须等于此值,否则 loader 拒载。
 * bump 规则:host 暴露给 plugin 的 register API / manifest 契约出现破坏性变更时 +1。
 */
export const PLUGIN_API_VERSION = "1" as const;

// ============================== marketplace source ==============================

/**
 * marketplace 来源(`settings.extraKnownMarketplaces.<name>.source` / `/plugin marketplace add`)。
 * 字符串简写:`owner/repo`、`owner/repo@ref`、本地路径、git URL;或显式对象。
 */
export const MarketplaceSourceSchema = z.union([
  z.string(),
  z
    .object({
      source: z.enum(["github", "url", "local"]),
      repo: z.string().optional(), // github: owner/repo
      url: z.string().optional(), // url: git url
      path: z.string().optional(), // local: 路径
      ref: z.string().optional(), // branch / tag
      sha: z.string().optional(), // 精确 commit(优先于 ref)
    })
    .passthrough(),
]);
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

// ============================== settings ==============================

/** `settings.extraKnownMarketplaces.<name>`。 */
export const KnownMarketplaceEntrySchema = z
  .object({ source: MarketplaceSourceSchema })
  .passthrough();
export const ExtraKnownMarketplacesSchema = z.record(KnownMarketplaceEntrySchema);
export type ExtraKnownMarketplaces = z.infer<typeof ExtraKnownMarketplacesSchema>;

/**
 * `settings.enabledPlugins`:key = `<plugin>@<marketplace>`,value = 是否启用。
 * 显式 opt-in:不在表里(或 false)则不加载。
 */
export const EnabledPluginsSchema = z.record(z.boolean());
export type EnabledPlugins = z.infer<typeof EnabledPluginsSchema>;

// ============================== plugin source(marketplace.json 内)==============================

/** marketplace.json 里单个 plugin 的获取源:相对路径(内联)/ github / git url。 */
export const PluginSourceSchema = z.union([
  z.string(), // 相对 marketplace repo 的路径(内联 plugin)
  z
    .object({
      source: z.enum(["github", "url"]),
      repo: z.string().optional(),
      url: z.string().optional(),
      ref: z.string().optional(),
      sha: z.string().optional(),
    })
    .passthrough(),
]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

// ============================== marketplace manifest ==============================

export const MarketplacePluginEntrySchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
    source: PluginSourceSchema,
    description: z.string().optional(),
    version: z.string().optional(),
    author: z.unknown().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    defaultEnabled: z.boolean().optional(),
  })
  .passthrough();
export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

/** `.muse-plugin/marketplace.json`。 */
export const MarketplaceManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
    owner: z
      .object({ name: z.string(), email: z.string().optional() })
      .passthrough(),
    description: z.string().optional(),
    version: z.string().optional(),
    metadata: z
      .object({ pluginRoot: z.string().optional() })
      .passthrough()
      .optional(),
    plugins: z.array(MarketplacePluginEntrySchema),
  })
  .passthrough();
export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

// ============================== plugin manifest ==============================

/**
 * Plugin manifest(`.muse-plugin/plugin.json`)。可选 —— 无 manifest 时按目录约定推断。
 *
 * 组件字段(skills/commands/mcpServers/hooks)路径相对 plugin 根;省略则走默认约定目录。
 * `main` 指向 register 入口(编程式注册 tools/slash/hooks)。
 */
export const PluginManifestSchema = z
  .object({
    apiVersion: z.string(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/).optional(), // 省略时用目录/marketplace 条目名兜底
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
    // —— 组件 ——
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    mcpServers: z.union([z.string(), z.record(z.unknown())]).optional(),
    hooks: z.union([z.string(), z.record(z.unknown())]).optional(),
    main: z.string().optional(),
  })
  .passthrough();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ============================== PluginContext(register API)==============================

/**
 * 暴露给 plugin register 函数的能力集(capability passing)。
 *
 * **刻意不暴露** process.env / fs / child_process / network —— plugin 要执行外部能力
 * 必须走 manifest 声明的 MCP server(子进程隔离 + PermissionGate)。
 */
export interface PluginContext {
  /** plugin 元信息;name 用作 slash/skill 的 namespace 前缀。 */
  readonly plugin: { name: string; version: string; root: string; dataDir: string };
  registerTool(tool: AnyTool): void;
  registerSlash(cmd: SlashCommand): void;
  registerHook(point: HookPoint, hook: PluginHookFn): void;
  logger: PluginLogger;
}

/** plugin 注册的 hook 回调(JS 函数,非外部 shell)。完整执行语义见 register 实现。 */
export type PluginHookFn = (
  input: Record<string, unknown>,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

/** plugin 主入口签名(manifest `main` 的 default export)。 */
export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>;

/** 给 plugin 的最小日志接口(避免依赖 host 内部 Logger 类)。 */
export interface PluginLogger {
  trace(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

// ============================== loader 运行期类型 ==============================

/** 加载失败记录(不阻塞启动,stderr 显示)。 */
export interface PluginLoadError {
  plugin: string; // <plugin>@<marketplace> 或路径
  reason: string;
}

export interface PluginLoadResult {
  loaded: string[]; // 成功加载的 <plugin>@<marketplace>
  errors: PluginLoadError[];
}
