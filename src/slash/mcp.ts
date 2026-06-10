/**
 * `/mcp` slash 命令 — MCP server 管理(status / disconnect / reconnect)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.5。
 *
 * 子命令:
 *   /mcp                          列所有 server 状态(等价 status)
 *   /mcp status                   同上
 *   /mcp disconnect <name>        显式断开 server(反注册其 tool,下次调用重连)
 *   /mcp reconnect <name>         断开 + 立即重连
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.js";
import { getMCPStatus } from "../mcp/index.js";
import type { MCPServerStatus } from "../mcp/index.js";

export const MCP: SlashCommand = {
  name: "mcp",
  description: "manage MCP servers (status / disconnect / reconnect)",
  argsHint: "[status | disconnect <name> | reconnect <name>]",
  async execute(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const args = ctx.args.trim();
    if (!args || args === "status") return runStatus(ctx);

    const [sub, ...rest] = args.split(/\s+/);
    const name = rest.join(" ").trim();
    if (sub === "disconnect") return runDisconnect(ctx, name);
    if (sub === "reconnect") return runReconnect(ctx, name);
    return { display: usageHelp() };
  },
};

function runStatus(ctx: SlashCommandContext): SlashCommandResult {
  const status = getMCPStatus(ctx.settings, ctx.mcpManager);
  if (status.length === 0) {
    return {
      display:
        `No MCP servers configured.\n` +
        `Add servers under "mcpServers" in your settings.json — see docs/操作手册.md §3.X.`,
    };
  }
  const lines = [`MCP servers (${status.length}):`];
  for (const s of status) lines.push(...formatStatusBlock(s));
  lines.push("");
  lines.push("Subcommands: `/mcp disconnect <name>` / `/mcp reconnect <name>`");
  return { display: lines.join("\n") };
}

function formatStatusBlock(s: MCPServerStatus): string[] {
  const indicator = s.connected ? "●" : "○";
  const out: string[] = [];
  out.push(`  ${indicator} ${s.name}${s.namespace !== s.name ? `  (namespace: ${s.namespace})` : ""}`);
  out.push(`      connected:  ${s.connected}${s.error ? `  (${s.error})` : ""}`);
  if (s.connected) out.push(`      tools:      ${s.toolCount}`);
  if (s.config?.command) {
    const args = s.config.args ? " " + s.config.args.join(" ") : "";
    out.push(`      command:    ${s.config.command}${args}`);
  }
  if (s.config?.url) out.push(`      url:        ${s.config.url}`);
  if (s.config?.trust) out.push(`      trust:      ${s.config.trust}`);
  return out;
}

async function runDisconnect(ctx: SlashCommandContext, name: string): Promise<SlashCommandResult> {
  if (!ctx.mcpManager) return { display: "MCP manager not initialized." };
  if (!name) return { display: "Usage: /mcp disconnect <name>" };
  try {
    await ctx.mcpManager.disconnect(name);
    return { display: `Disconnected MCP server "${name}". Its tools are unregistered; next invocation will reconnect.` };
  } catch (err) {
    return { display: `Failed to disconnect "${name}": ${(err as Error).message}` };
  }
}

async function runReconnect(ctx: SlashCommandContext, name: string): Promise<SlashCommandResult> {
  if (!ctx.mcpManager) return { display: "MCP manager not initialized." };
  if (!name) return { display: "Usage: /mcp reconnect <name>" };
  try {
    await ctx.mcpManager.reconnect(name);
    const s = ctx.mcpManager.status().find((x) => x.name === name);
    const tools = s?.toolCount ?? 0;
    return { display: `Reconnected MCP server "${name}" (${tools} tool${tools === 1 ? "" : "s"} re-registered).` };
  } catch (err) {
    return { display: `Failed to reconnect "${name}": ${(err as Error).message}` };
  }
}

function usageHelp(): string {
  return [
    "Usage:",
    "  /mcp                       show MCP server status (same as `status`)",
    "  /mcp status                same as above",
    "  /mcp disconnect <name>     disconnect a server (unregister its tools; next call reconnects)",
    "  /mcp reconnect <name>      disconnect + immediately reconnect",
  ].join("\n");
}
