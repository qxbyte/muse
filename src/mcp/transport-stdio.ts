/**
 * MCP stdio transport wrapper。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.4 / §四.10。
 *
 * 包装 `@modelcontextprotocol/sdk` 的 Client + StdioClientTransport,做两件事:
 *   1. **动态 import** SDK(optionalDependency)— 缺失时抛 MCPSdkMissingError,
 *      让 manager 优雅降级 + 给用户安装提示;**不阻塞 muse 启动**
 *   2. 用 muse 自家 env 注入 + 默认 client metadata 提供
 *
 * Manager 拿到返回的 connection 后,自己做 listTools / callTool / close。
 */

import type { MCPServerConfig } from "./types.js";

export interface MCPConnection {
  /** SDK Client 实例 — 已完成 handshake,可调 listTools / callTool / close。
   *  unknown 因为 SDK 是 dynamic import,本文件不引类型(避免 hard dep)。 */
  client: McpClient;
  /** 关闭连接 + 终止 stdio 子进程(SDK Client.close 内部会清理 transport)。 */
  close: () => Promise<void>;
}

/** SDK Client 的运行期接口(我们只用以下方法 — 减少 hard typing 依赖)。 */
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
 * 启 stdio 子进程 + 完成 MCP handshake(initialize)。
 * 失败抛错(spawn 错 / 版本协商错 / 子进程立刻退出 等)— 由 manager 兜底。
 */
export async function openStdioConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<MCPConnection> {
  if (!config.command) {
    throw new Error(`MCP server "${serverName}" missing required 'command' field`);
  }
  const sdk = await loadSdk();
  const transport = new sdk.StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: mergeEnv(config.env),
  });
  const client = new sdk.Client(
    { name: "muse", version: "0.2.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client: client as McpClient,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore — 子进程可能已经死了
      }
    },
  };
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

// ============================== SDK 动态加载 ==============================

interface SdkExports {
  Client: new (
    info: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ) => {
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
    callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<{ content?: unknown; isError?: boolean }>;
    close(): Promise<void>;
  };
  StdioClientTransport: new (params: { command: string; args?: string[]; env?: Record<string, string> }) => unknown;
}

let _sdkCache: SdkExports | undefined;
let _sdkLoadFailed = false;

async function loadSdk(): Promise<SdkExports> {
  if (_sdkCache) return _sdkCache;
  if (_sdkLoadFailed) throw new MCPSdkMissingError();
  try {
    const [clientMod, stdioMod] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    _sdkCache = {
      Client: clientMod.Client as unknown as SdkExports["Client"],
      StdioClientTransport: stdioMod.StdioClientTransport as unknown as SdkExports["StdioClientTransport"],
    };
    return _sdkCache;
  } catch {
    _sdkLoadFailed = true;
    throw new MCPSdkMissingError();
  }
}

/** Manager 启动期用此检查 SDK 可用性(避免重复抛错日志)。 */
export async function isSdkAvailable(): Promise<boolean> {
  try {
    await loadSdk();
    return true;
  } catch {
    return false;
  }
}
