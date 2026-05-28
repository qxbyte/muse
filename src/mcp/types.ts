/**
 * MCP 状态查询的类型。
 *
 * 设计文档：muse-design.md §6.2 MCP 协议接入（v0.3 范围）。
 *
 * v0.1 占位：只读 settings.mcpServers，所有 server 标 connected=false。
 * v0.3 接 @modelcontextprotocol/sdk 后：本文件不动；getMCPStatus 内部改成实查。
 */

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

export interface MCPServerStatus {
  name: string;
  configured: boolean;
  connected: boolean;
  /** 已连接时填，v0.1 始终 0。 */
  toolCount: number;
  /** 未连接 / 连接失败时的原因。 */
  error?: string;
  config?: MCPServerConfig;
}
