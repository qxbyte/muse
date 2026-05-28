/**
 * MCP 状态查询入口（v0.1 占位，v0.3 真接 SDK）。
 *
 * 当前仅根据 settings.mcpServers 配置返回"已配置但未连接"的状态。
 * /mcp 命令读这里；不依赖任何 MCP 运行时。
 */

import type { Settings } from "../config/types.js";
import type { MCPServerStatus, MCPServerConfig } from "./types.js";

const NOT_IMPLEMENTED = "MCP client not implemented (planned for v0.3)";

export function getMCPStatus(settings: Settings): MCPServerStatus[] {
  const servers = (settings.mcpServers ?? {}) as Record<string, MCPServerConfig>;
  return Object.entries(servers).map(([name, config]) => ({
    name,
    configured: true,
    connected: false,
    toolCount: 0,
    error: NOT_IMPLEMENTED,
    config,
  }));
}

export type { MCPServerStatus, MCPServerConfig } from "./types.js";
