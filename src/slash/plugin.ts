/**
 * `/plugin` slash 命令 — plugin / marketplace 管理(Plugins v0.4)。
 *
 * 设计文档:模块设计/Plugins/设计.md §九。
 *
 * 子命令:
 *   /plugin [list]                       列出 marketplaces 里的 plugin + 状态
 *   /plugin install <plugin>@<mp>        安装 + 启用
 *   /plugin uninstall <plugin>@<mp>      移除启用
 *   /plugin enable | disable <plugin>@<mp>
 *   /plugin update <plugin>@<mp>         重新 fetch
 *   /plugin marketplace add <source>     添加 marketplace(owner/repo / git url / 本地路径)
 *   /plugin marketplace list | remove <name> | update [name]
 *
 * 改动落 settings(默认 user scope ~/.muse/settings.json)+ cache;**生效需重启 muse**。
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.js";
import { createPluginPaths, readKnownMarketplaces } from "../plugins/cache.js";
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  listPlugins,
  settingsPathForScope,
} from "../plugins/manage.js";

const RESTART_HINT = "Restart muse to apply.";

export const PLUGIN: SlashCommand = {
  name: "plugin",
  description: "manage plugins & marketplaces (list / install / enable / marketplace add)",
  argsHint: "[list | install <p@m> | enable/disable <p@m> | marketplace add <src>]",
  async execute(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const args = ctx.args.trim();
    const [sub, ...rest] = args ? args.split(/\s+/) : [];

    try {
      if (!sub || sub === "list") return runList(ctx);
      if (sub === "marketplace") return await runMarketplace(ctx, rest);
      if (sub === "install" || sub === "update") return await runInstall(ctx, rest[0]);
      if (sub === "uninstall") return runUninstall(ctx, rest[0]);
      if (sub === "enable") return runEnable(ctx, rest[0], true);
      if (sub === "disable") return runEnable(ctx, rest[0], false);
      return { display: usage() };
    } catch (err) {
      return { display: `[plugin] error: ${(err as Error).message}` };
    }
  },
};

function paths() {
  return createPluginPaths();
}
function userSettings(ctx: SlashCommandContext): string {
  return settingsPathForScope("user", { cwd: ctx.cwd });
}

function runList(ctx: SlashCommandContext): SlashCommandResult {
  const items = listPlugins({ paths: paths(), enabledPlugins: ctx.settings.enabledPlugins ?? {} });
  if (items.length === 0) {
    return { display: "No plugins. Add a marketplace: /plugin marketplace add <owner/repo | path>" };
  }
  const lines = ["Plugins:"];
  for (const it of items) {
    const flags = [it.enabled ? "enabled" : "disabled", it.installed ? "installed" : "not installed"].join(", ");
    lines.push(`  ${it.key}  (${flags})`);
  }
  lines.push("", "Use `/plugin install <plugin>@<marketplace>` then restart.");
  return { display: lines.join("\n") };
}

async function runInstall(ctx: SlashCommandContext, key?: string): Promise<SlashCommandResult> {
  if (!key) return { display: "Usage: /plugin install <plugin>@<marketplace>" };
  const r = await installPlugin({ key, paths: paths(), settingsPath: userSettings(ctx) });
  return { display: `Installed ${r.key}@${r.version} and enabled. ${RESTART_HINT}` };
}

function runUninstall(ctx: SlashCommandContext, key?: string): SlashCommandResult {
  if (!key) return { display: "Usage: /plugin uninstall <plugin>@<marketplace>" };
  uninstallPlugin({ key, paths: paths(), settingsPath: userSettings(ctx), purgeCache: true });
  return { display: `Uninstalled ${key}. ${RESTART_HINT}` };
}

function runEnable(ctx: SlashCommandContext, key: string | undefined, enabled: boolean): SlashCommandResult {
  if (!key) return { display: `Usage: /plugin ${enabled ? "enable" : "disable"} <plugin>@<marketplace>` };
  setPluginEnabled({ key, enabled, settingsPath: userSettings(ctx) });
  return { display: `${enabled ? "Enabled" : "Disabled"} ${key}. ${RESTART_HINT}` };
}

async function runMarketplace(ctx: SlashCommandContext, rest: string[]): Promise<SlashCommandResult> {
  const [sub, ...args] = rest;
  if (sub === "add") {
    if (!args[0]) return { display: "Usage: /plugin marketplace add <owner/repo | git-url | path>" };
    const r = await addMarketplace({ source: args[0], paths: paths(), settingsPath: userSettings(ctx) });
    return { display: `Added marketplace "${r.name}" (${r.pluginCount} plugin(s)). Use \`/plugin list\`.` };
  }
  if (sub === "remove") {
    if (!args[0]) return { display: "Usage: /plugin marketplace remove <name>" };
    const ok = removeMarketplace({ name: args[0], paths: paths(), settingsPath: userSettings(ctx) });
    return { display: ok ? `Removed marketplace "${args[0]}". ${RESTART_HINT}` : `Marketplace "${args[0]}" not found.` };
  }
  if (sub === "update") {
    const known = readKnownMarketplaces(paths());
    const names = args[0] ? [args[0]] : Object.keys(known);
    if (names.length === 0) return { display: "No marketplaces to update." };
    const done: string[] = [];
    for (const name of names) {
      const rec = known[name];
      if (!rec) continue;
      const r = await addMarketplace({ source: rec.source, paths: paths(), settingsPath: userSettings(ctx) });
      done.push(r.name);
    }
    return { display: `Updated marketplace(s): ${done.join(", ") || "(none)"}.` };
  }
  // list(默认)
  const mps = listMarketplaces(paths());
  if (mps.length === 0) return { display: "No marketplaces. Add: /plugin marketplace add <owner/repo | path>" };
  const lines = ["Marketplaces:"];
  for (const m of mps) lines.push(`  ${m.name}  ${JSON.stringify(m.source)}`);
  return { display: lines.join("\n") };
}

function usage(): string {
  return [
    "Usage:",
    "  /plugin [list]                          list plugins + status",
    "  /plugin install <plugin>@<marketplace>  install + enable (restart to apply)",
    "  /plugin uninstall|enable|disable <p@m>",
    "  /plugin update <plugin>@<marketplace>   re-fetch",
    "  /plugin marketplace add <owner/repo | git-url | path>",
    "  /plugin marketplace list | remove <name> | update [name]",
  ].join("\n");
}
