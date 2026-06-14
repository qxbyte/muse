/**
 * MCP Streamable HTTP transport(v0.3.x)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.1 / §十(v0.3.x)。
 *
 * 连远程 MCP server(Streamable HTTP,协议 2025-11-25)。
 * 自定义请求头(如 Authorization)走 config.headers → requestInit.headers。
 * OAuth(F1)留后续:本期只支持静态 headers 鉴权。
 * SDK Client 装配 / 动态加载在 transport.ts(stdio / http 共用)。
 */

import type { MCPServerConfig } from "./types.js";
import {
  connectClient,
  loadTransportExport,
  type MCPConnection,
} from "./transport.js";

type HttpTransportCtor = new (
  url: URL,
  opts?: { requestInit?: { headers?: Record<string, string> } },
) => unknown;

/**
 * 连 Streamable HTTP server + 完成 handshake。
 * 失败抛错(缺 url / URL 非法 / 连接错 / 版本协商错 等)— 由 manager 兜底。
 */
export async function openHttpConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<MCPConnection> {
  if (!config.url) {
    throw new Error(`MCP server "${serverName}" missing required 'url' field`);
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`MCP server "${serverName}" has invalid url: ${config.url}`);
  }
  const StreamableHTTPClientTransport = await loadTransportExport<HttpTransportCtor>(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
    "StreamableHTTPClientTransport",
  );
  const transport = new StreamableHTTPClientTransport(
    url,
    config.headers ? { requestInit: { headers: config.headers } } : undefined,
  );
  return connectClient(transport);
}
