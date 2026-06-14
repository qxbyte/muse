/**
 * MCPManager — server 生命周期 + tool 路由 + 状态。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.4 / §四.5 / §四.6 / §四.8。
 *
 * 设计要点(对齐业界共识):
 *   - **懒加载**:启动期仅记 manifest;首次工具调用时 spawn 子进程 + handshake +
 *     listTools + 注册到 ToolRegistry
 *   - **崩溃自愈**:server 崩了 / 超时 → 标 disconnected + 反注册 tool,下次调用
 *     重新 spawn
 *   - **trust 路由**:auto(信任)/ ask(走 PermissionGate;默认)/ deny(永远拒)
 *   - **命名空间**:tool 注册为 `mcp__<namespace>__<rawTool>`(双下划线共识)
 */

import type { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import type { PermissionLevel } from "../tools/types.js";
import { log } from "../log/index.js";
import { jsonSchemaToZod } from "./zod-from-jsonschema.js";
import {
  openConnection,
  MCPSdkMissingError,
  type MCPConnection,
} from "./transport.js";
import type { MCPServerConfig, MCPServerStatus } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30000;

/** 单个 server 的运行期状态(manager 持有 Map<name, ServerState>)。 */
interface ServerState {
  name: string;
  namespace: string;
  config: MCPServerConfig;
  connection?: MCPConnection;
  /** 已注册到 ToolRegistry 的完整 tool 名(`mcp__<ns>__<raw>`);disconnect 时反注册。 */
  registeredTools: Set<string>;
  connected: boolean;
  /** 最后一次失败原因;成功后清空。 */
  error?: string;
}

export interface MCPManagerOpts {
  servers: Record<string, MCPServerConfig>;
  toolRegistry: ToolRegistry;
}

export class MCPManager {
  private servers = new Map<string, ServerState>();
  private toolRegistry: ToolRegistry;

  constructor(opts: MCPManagerOpts) {
    this.toolRegistry = opts.toolRegistry;
    for (const [name, config] of Object.entries(opts.servers)) {
      if (config.enabled === false) continue;
      const namespace = config.namespace ?? name;
      this.servers.set(name, {
        name,
        namespace,
        config,
        registeredTools: new Set(),
        connected: false,
      });
    }
  }

  /** 启动期:仅记 manifest,不 spawn。返回 enabled server 总数。 */
  init(): number {
    return this.servers.size;
  }

  /** 给定 server 的 trust 等级(用于 PermissionGate 路由);未配置 → undefined。 */
  getTrust(serverName: string): "auto" | "ask" | "deny" | undefined {
    return this.servers.get(serverName)?.config.trust;
  }

  /** 返回所有 server 的当前状态(给 /mcp slash 用)。 */
  status(): MCPServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      namespace: s.namespace,
      configured: true,
      connected: s.connected,
      toolCount: s.registeredTools.size,
      error: s.error,
      config: s.config,
    }));
  }

  /**
   * 把 `mcp__<ns>__<raw>` 拆成 server name + 原 tool 名;不匹配返 null。
   * agent.ts 用此快速识别工具是 MCP 来源。
   */
  parseQualifiedName(toolName: string): { serverName: string; rawTool: string } | null {
    if (!toolName.startsWith("mcp__")) return null;
    const rest = toolName.slice(5);
    const sep = rest.indexOf("__");
    if (sep <= 0) return null;
    const namespace = rest.slice(0, sep);
    const rawTool = rest.slice(sep + 2);
    if (!rawTool) return null;
    for (const s of this.servers.values()) {
      if (s.namespace === namespace) return { serverName: s.name, rawTool };
    }
    return null;
  }

  /** 调用 MCP tool;懒连接 → callTool → 返结构化结果(给 ToolExecuteResult 包装)。 */
  async invoke(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const parsed = this.parseQualifiedName(toolName);
    if (!parsed) return errResult(`Invalid MCP tool name: ${toolName}`);
    const state = this.servers.get(parsed.serverName);
    if (!state) return errResult(`MCP server "${parsed.serverName}" not configured`);
    if (state.config.trust === "deny") {
      return errResult(`MCP server "${parsed.serverName}" trust=deny; tool blocked.`);
    }
    if (!state.connection) {
      try {
        await this.connect(parsed.serverName);
      } catch (err) {
        return errResult(formatConnectError(parsed.serverName, err));
      }
    }
    const conn = state.connection;
    if (!conn) return errResult(state.error ?? "MCP server not connected");
    const timeoutMs = state.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await callWithTimeout(
        () => conn.client.callTool({ name: parsed.rawTool, arguments: argsToRecord(args) }),
        timeoutMs,
        signal,
      );
      return stringifyMcpResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markDisconnected(parsed.serverName, msg);
      return errResult(`MCP error: ${msg}`);
    }
  }

  /** 关闭所有 server(进程退出 / 测试清理)。 */
  async shutdown(): Promise<void> {
    for (const s of this.servers.values()) {
      if (s.connection) {
        try {
          await s.connection.close();
        } catch {
          // ignore
        }
      }
      s.connection = undefined;
      s.connected = false;
    }
  }

  /** 显式断开 server(/mcp disconnect)— 反注册 tool。 */
  async disconnect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`MCP server "${name}" not configured`);
    if (state.connection) {
      try {
        await state.connection.close();
      } catch {
        // ignore
      }
    }
    state.connection = undefined;
    state.connected = false;
    for (const t of state.registeredTools) this.toolRegistry.unregister(t);
    state.registeredTools.clear();
  }

  async reconnect(name: string): Promise<void> {
    await this.disconnect(name);
    await this.connect(name);
  }

  // ============================== 内部 ==============================

  private async connect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`MCP server "${name}" not configured`);
    try {
      state.connection = await openConnection(name, state.config);
      state.connected = true;
      state.error = undefined;
      await this.registerTools(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.error = msg;
      state.connected = false;
      state.connection = undefined;
      throw err;
    }
  }

  /** 子进程死掉 / tool 调用超时后调:清状态 + 反注册 tool;不抛错。 */
  private async markDisconnected(name: string, reason: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    if (state.connection) {
      try {
        await state.connection.close();
      } catch {
        // ignore
      }
    }
    state.connection = undefined;
    state.connected = false;
    state.error = reason;
    for (const t of state.registeredTools) this.toolRegistry.unregister(t);
    state.registeredTools.clear();
    log.warn(`[mcp] server "${name}" disconnected: ${reason}`);
  }

  /** listTools → 包装成 muse 的 AnyTool 注册到 ToolRegistry。 */
  private async registerTools(state: ServerState): Promise<void> {
    if (!state.connection) return;
    const { tools } = await state.connection.client.listTools();
    for (const t of tools) {
      const qualified = `mcp__${state.namespace}__${t.name}`;
      if (this.toolRegistry.has(qualified)) {
        log.warn(`[mcp] tool "${qualified}" already registered; skipping duplicate`);
        continue;
      }
      const tool = defineTool({
        name: qualified,
        description: `[MCP:${state.namespace}] ${t.description ?? ""}`.trim(),
        parameters: jsonSchemaToZod(t.inputSchema),
        permission: inferPermission(t.name),
        execute: async (args, ctx) => {
          const result = await this.invoke(qualified, args, ctx.abortSignal);
          return {
            content: result.text,
            isError: result.isError,
            summary: oneLineSummary(result.text),
          };
        },
      });
      this.toolRegistry.register(tool);
      state.registeredTools.add(qualified);
    }
  }
}

// ============================== helpers ==============================

/**
 * 从 tool name 推断权限级别(给 PermissionGate 用)。
 * trust=auto 时此值不重要(全放行);trust=ask 时决定 plan 模式下能否调用。
 */
function inferPermission(toolName: string): PermissionLevel {
  const lc = toolName.toLowerCase();
  if (/(read|list|get|query|search|view|info|describe|status)/.test(lc)) return "read";
  if (/(write|create|update|delete|insert|put|mutate|edit|patch)/.test(lc)) return "write";
  if (/(exec|run|shell|spawn|kill|start|stop|restart)/.test(lc)) return "execute";
  return "network";
}

/** 把 zod-parsed args(unknown)转成 Record;非 object 兜底空。 */
function argsToRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

/** SDK CallToolResult.content 是 ContentBlock[] — 把 text 块拼起来,非 text 块 JSON.stringify。 */
function stringifyMcpResult(result: { content?: unknown; isError?: boolean }): {
  text: string;
  isError: boolean;
} {
  const isError = !!result.isError;
  if (!Array.isArray(result.content)) {
    return { text: result.content == null ? "" : JSON.stringify(result.content), isError };
  }
  const text = result.content
    .map((b) => {
      if (b == null) return "";
      if (typeof b !== "object") return String(b);
      const block = b as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return JSON.stringify(b);
    })
    .join("\n");
  return { text, isError };
}

function oneLineSummary(text: string): string {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (first.length <= 80) return first;
  return first.slice(0, 77) + "...";
}

function errResult(text: string): { text: string; isError: boolean } {
  return { text, isError: true };
}

function formatConnectError(name: string, err: unknown): string {
  if (err instanceof MCPSdkMissingError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  return `Failed to connect to MCP server "${name}": ${msg}`;
}

/** 带超时 + abort 的 promise 包装。 */
async function callWithTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`tool call timeout after ${ms}ms`));
    }, ms);
    if (signal) {
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    fn().then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
