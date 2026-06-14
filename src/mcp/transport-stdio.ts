/**
 * MCP stdio transport。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.4 / §四.10。
 *
 * 启本地子进程(npx / uvx / node / python 等)+ 完成 MCP handshake。
 * SDK Client 装配 / 动态加载在 transport.ts(stdio / http 共用)。
 */

import type { MCPServerConfig } from "./types.js";
import {
  connectClient,
  loadTransportExport,
  type MCPConnection,
} from "./transport.js";

type StdioTransportCtor = new (params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}) => unknown;

/**
 * 启 stdio 子进程 + 完成 handshake。
 * 失败抛错(缺 command / spawn 错 / 版本协商错 / 子进程立刻退出 等)— 由 manager 兜底。
 */
export async function openStdioConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<MCPConnection> {
  if (!config.command) {
    throw new Error(`MCP server "${serverName}" missing required 'command' field`);
  }
  const StdioClientTransport = await loadTransportExport<StdioTransportCtor>(
    "@modelcontextprotocol/sdk/client/stdio.js",
    "StdioClientTransport",
  );
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: mergeEnv(config.env),
  });
  return connectClient(transport);
}

/** 把用户 settings.env(per-server)叠加到 process.env;子进程继承宿主 env。 */
function mergeEnv(serverEnv: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  if (serverEnv) {
    for (const [k, v] of Object.entries(serverEnv)) {
      out[k] = v;
    }
  }
  return out;
}
