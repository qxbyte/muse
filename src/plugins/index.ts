/**
 * Plugins 模块入口(P1 骨架)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §六。
 *
 * 本期只导出类型 + schema 契约;loader / activationEvents 引擎 / SDK 子包发布
 * 留 v0.4(单独文档 模块设计/Plugins/设计.md)。
 */

export {
  PLUGIN_API_VERSION,
  PluginsConfigSchema,
  PluginManifestSchema,
} from "./types.js";

export type {
  PluginsConfig,
  PluginManifest,
  PluginContext,
  PluginHookFn,
  PluginRegisterFn,
  PluginLogger,
} from "./types.js";
