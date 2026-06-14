/**
 * MCP transport 共享核心。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.4 / §四.10 / §十(v0.3.x HTTP)。
 *
 * 两种 transport(stdio / Streamable HTTP)共用:
 *   - MCPConnection / McpClient 运行期接口(transport 无关 — manager 只看这层)
 *   - SDK Client 类的 **动态 import**(optionalDependency,缺失抛 MCPSdkMissingError)
 *   - connectClient():把任意 SDK transport 接上 Client + 完成 handshake
 *   - openConnection():按配置判定 transport 种类后派发到 stdio / http
 *
 * 各 transport 自己的子进程 / HTTP 细节在 transport-stdio.ts / transport-http.ts。
 */

import { VERSION } from "../version.js";
import { resolveTransportKind, type MCPServerConfig } from "./types.js";

export interface MCPConnection {
  /** SDK Client 实例 — 已完成 handshake,可调 listTools / callTool / close。 */
  client: McpClient;
  /** 关闭连接 + 释放 transport(SDK Client.close 内部清理子进程 / HTTP session)。 */
  close: () => Promise<void>;
}

/** SDK Client 的运行期接口(只用以下方法 — 减少 hard typing 依赖)。 */
export interface McpClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

/** SDK 缺失时抛此错;manager 捕获后给用户安装提示并跳过该 server。 */
export class MCPSdkMissingError extends Error {
  constructor() {
    super(
      "@modelcontextprotocol/sdk not installed. Run: npm i -g @modelcontextprotocol/sdk",
    );
    this.name = "MCPSdkMissingError";
  }
}

/**
 * transport 派发器:按配置判定 stdio / http 后建立连接。
 * 失败抛错(transport 互斥冲突 / spawn 错 / 版本协商错 / HTTP 连接错)— 由 manager 兜底。
 */
export async function openConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<MCPConnection> {
  const kind = resolveTransportKind(serverName, config);
  // 动态 import 避免 stdio/http 互相牵连;两者都依赖 transport.ts 但彼此独立。
  if (kind === "http") {
    const { openHttpConnection } = await import("./transport-http.js");
    return openHttpConnection(serverName, config);
  }
  const { openStdioConnection } = await import("./transport-stdio.js");
  return openStdioConnection(serverName, config);
}

/**
 * 把已建好的 SDK transport 接上 Client 并完成 handshake,包成 MCPConnection。
 * stdio / http 各自造好 transport 后调此函数,避免 Client 装配逻辑重复。
 */
export async function connectClient(transport: unknown): Promise<MCPConnection> {
  const Client = await loadClientClass();
  const client = new Client({ name: "muse", version: VERSION }, { capabilities: {} });
  await client.connect(transport);
  return {
    client: client as McpClient,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore — 子进程 / 连接可能已经死了
      }
    },
  };
}

// ============================== SDK 动态加载 ==============================

type ClientCtor = new (
  info: { name: string; version: string },
  options: { capabilities: Record<string, unknown> },
) => {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
};

let _clientCache: ClientCtor | undefined;
let _clientLoadFailed = false;

/** 加载 SDK Client 类(stdio / http 共用);缺失抛 MCPSdkMissingError。 */
async function loadClientClass(): Promise<ClientCtor> {
  if (_clientCache) return _clientCache;
  if (_clientLoadFailed) throw new MCPSdkMissingError();
  try {
    const mod = await import("@modelcontextprotocol/sdk/client/index.js");
    _clientCache = mod.Client as unknown as ClientCtor;
    return _clientCache;
  } catch {
    _clientLoadFailed = true;
    throw new MCPSdkMissingError();
  }
}

/**
 * 动态 import 一个 SDK transport 子模块的具名导出;缺失统一抛 MCPSdkMissingError。
 * stdio / http transport 各自调此拿自己的 Transport 类。
 */
export async function loadTransportExport<T>(modulePath: string, exportName: string): Promise<T> {
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const ctor = mod[exportName];
    if (!ctor) throw new Error(`SDK missing export ${exportName}`);
    return ctor as T;
  } catch {
    throw new MCPSdkMissingError();
  }
}

/** Manager 启动期用此检查 SDK 可用性(避免重复抛错日志)。 */
export async function isSdkAvailable(): Promise<boolean> {
  try {
    await loadClientClass();
    return true;
  } catch {
    return false;
  }
}
