/**
 * MCP 模块对外汇总 export。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四。
 *
 * 接入路径:
 *   cli.tsx / app.tsx 启动期 → new MCPManager({servers, toolRegistry}) → manager.init()
 *   /mcp slash 拿 manager → status() 显示真实 server 状态
 *   agent.ts 工具调用 → 名字以 mcp__* 开头 → manager.invoke()(在 registry.execute 内自然透传)
 */

import type { Settings } from "../config/types.js";
import type { MCPServerStatus, MCPServerConfig } from "./types.js";
import { MCPManager } from "./manager.js";

/**
 * /mcp slash 用此读取状态。
 *
 *   - 有 manager → 实查 manager.status()(连接状态、tool count、错误)
 *   - 无 manager(legacy 路径 / 测试)→ 仅读 settings,返回 placeholder
 */
export function getMCPStatus(settings: Settings, manager?: MCPManager): MCPServerStatus[] {
  if (manager) return manager.status();
  const servers = (settings.mcpServers ?? {}) as Record<string, MCPServerConfig>;
  return Object.entries(servers).map(([name, config]) => ({
    name,
    namespace: config.namespace ?? name,
    configured: true,
    connected: false,
    toolCount: 0,
    error: "MCP manager not initialized",
    config,
  }));
}

export { MCPManager } from "./manager.js";
export type { MCPManagerOpts } from "./manager.js";
export { decideMCPOrPlain } from "./agent-bridge.js";
export type { MCPDecideInput } from "./agent-bridge.js";
export {
  openStdioConnection,
  isSdkAvailable,
  MCPSdkMissingError,
} from "./transport-stdio.js";
export type { MCPConnection, McpClient } from "./transport-stdio.js";

export type {
  MCPServerStatus,
  MCPServerConfig,
  MCPToolResult,
  MCPToolDef,
  MCPTrust,
} from "./types.js";
export { MCPServerConfigSchema } from "./types.js";

export { jsonSchemaToZod } from "./zod-from-jsonschema.js";
