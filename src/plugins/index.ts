/**
 * Plugins 模块入口(v0.4)。
 *
 * 设计文档:模块设计/Plugins/设计.md。
 */

export {
  PLUGIN_API_VERSION,
  MarketplaceSourceSchema,
  KnownMarketplaceEntrySchema,
  ExtraKnownMarketplacesSchema,
  EnabledPluginsSchema,
  PluginSourceSchema,
  MarketplacePluginEntrySchema,
  MarketplaceManifestSchema,
  PluginManifestSchema,
} from "./types.js";

export type {
  MarketplaceSource,
  ExtraKnownMarketplaces,
  EnabledPlugins,
  PluginSource,
  MarketplacePluginEntry,
  MarketplaceManifest,
  PluginManifest,
  PluginContext,
  PluginHookFn,
  PluginRegisterFn,
  PluginLogger,
  PluginLoadError,
  PluginLoadResult,
} from "./types.js";

// cache
export {
  defaultPluginsRoot,
  createPluginPaths,
  readKnownMarketplaces,
  writeKnownMarketplaces,
  upsertKnownMarketplace,
  removeKnownMarketplace,
  listPluginVersions,
  pruneOldVersions,
} from "./cache.js";
export type { PluginPaths, KnownMarketplaces } from "./cache.js";

// marketplace
export {
  parseMarketplaceManifest,
  loadMarketplaceManifest,
  findPluginEntry,
  normalizeMarketplaceSource,
  resolveInlinePluginDir,
  MARKETPLACE_MANIFEST_REL,
} from "./marketplace.js";

// fetch
export { copyDir, gitClone, fetchMarketplace, fetchPlugin } from "./fetch.js";

// loader / register
export { loadEnabledPlugins, parsePluginKey } from "./loader.js";
export type { PluginContributions, LoadPluginsOpts } from "./loader.js";
export { createPluginContext, substitutePathVars } from "./register.js";
export type { PluginSink } from "./register.js";
