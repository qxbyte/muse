/**
 * MCP 模块对外汇总 export。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四。
 *
 * v0.3 本期(M1):仅类型 + JSON Schema → zod helper + 旧 getMCPStatus 占位保留。
 * M2/M3/M4 将加 manager / transport / agent 路由,届时 getMCPStatus 改为实查。
 */

import type { Settings } from "../config/types.js";
import type { MCPServerStatus, MCPServerConfig } from "./types.js";

const NOT_IMPLEMENTED = "MCP manager not yet wired (M2 — planned next commit)";

/**
 * 旧 /mcp 占位:只读 settings.mcpServers,所有 server 标 connected=false。
 * 下个 commit(M2)接 MCPManager 后,此函数会接受 manager 参数并返实查状态。
 */
export function getMCPStatus(settings: Settings): MCPServerStatus[] {
  const servers = (settings.mcpServers ?? {}) as Record<string, MCPServerConfig>;
  return Object.entries(servers).map(([name, config]) => ({
    name,
    namespace: config.namespace ?? name,
    configured: true,
    connected: false,
    toolCount: 0,
    error: NOT_IMPLEMENTED,
    config,
  }));
}

export type {
  MCPServerStatus,
  MCPServerConfig,
  MCPToolResult,
  MCPToolDef,
  MCPTrust,
} from "./types.js";
export { MCPServerConfigSchema } from "./types.js";

export { jsonSchemaToZod } from "./zod-from-jsonschema.js";
