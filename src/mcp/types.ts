/**
 * MCP 模块类型。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.2 / §四.4。
 *
 * v0.3 实接 `@modelcontextprotocol/sdk`(stdio transport)。
 * SDK 是 optionalDependencies — 缺失时 manager 早期跳过启动 + stderr 提示。
 */

import { z } from "zod";

/** trust 三态(设计文档 §四.7):决定 PermissionGate 路由策略。 */
export type MCPTrust = "auto" | "ask" | "deny";

/**
 * 单个 MCP server 配置(`settings.mcpServers.<name>`)。
 *
 * 字段对齐 Claude Desktop / Cursor / Windsurf 共识(stdio 子进程形式)+
 * muse 自家扩展:`enabled / trust / namespace / timeoutMs`。
 *
 * 当前(v0.3.0)仅支持 stdio:必须有 `command`。HTTP 留 v0.3.x(`url` 字段已占位)。
 */
export const MCPServerConfigSchema = z.object({
  /** stdio 子进程命令(npx / uvx / node / python 等)。 */
  command: z.string().optional(),
  /** 子进程参数。 */
  args: z.array(z.string()).optional(),
  /** 透给子进程的环境变量。 */
  env: z.record(z.string()).optional(),
  /** HTTP server URL(v0.3.x 才实装,本期忽略)。 */
  url: z.string().optional(),
  /** 默认 true;false 则忽略,不启动子进程。 */
  enabled: z.boolean().optional(),
  /** PermissionGate 路由策略:
   *  - "auto":每次调用直接放行(信任 server) — 适合本地 filesystem / git 等无副作用 server
   *  - "ask"(默认):走 PermissionPrompt,每次询问用户
   *  - "deny":永远拒绝(server 注册了 tool 但全部 reject — 适合临时禁用) */
  trust: z.enum(["auto", "ask", "deny"]).optional(),
  /** Override 默认 server 名(tool 变 `mcp__<namespace>__<tool>`)。 */
  namespace: z.string().optional(),
  /** 单次 tool 调用超时(毫秒);默认 30000。 */
  timeoutMs: z.number().int().positive().optional(),
}).passthrough();

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** server 当前运行状态(供 `/mcp` slash 与 manager 内部查) — runtime only,不入 settings。 */
export interface MCPServerStatus {
  /** 配置 key(可能与 namespace 不同)。 */
  name: string;
  /** namespace(默认等于 name,被 config 覆盖时不同)。 */
  namespace: string;
  /** 是否在 settings.mcpServers 中被声明(configured=false 时为何还出现 — 用户用 disconnect 后保留状态)。 */
  configured: boolean;
  /** 当前是否有活的 stdio 子进程 + MCP session。 */
  connected: boolean;
  /** 已注册到 ToolRegistry 的 tool 数(connected=false 时 0)。 */
  toolCount: number;
  /** 未连接 / 连接失败时的原因(server crash / spawn error / handshake fail)。 */
  error?: string;
  /** 配置原文(供 /mcp 显示;不暴露 env / secrets 细节)。 */
  config?: MCPServerConfig;
}

/**
 * MCP tool 调用结果(SDK 返回的 result.content 数组的简化形式)。
 * 与 src/tools/types.ts 的 ToolExecuteResult 对齐 — manager.invoke 转换后返。
 */
export interface MCPToolResult {
  /** 文本内容(SDK content blocks 的 text type 拼接);非 text block 已被 stringify。 */
  text: string;
  /** server 自报错误(协议层 error,与 transport 错误区分)。 */
  isError: boolean;
}

/** MCP tool 元数据(从 server.listTools() 拿;转 ToolRegistry 用)。 */
export interface MCPToolDef {
  /** server 原始 tool 名(未加 `mcp__<server>__` 前缀)。 */
  name: string;
  description?: string;
  /** server 自报 inputSchema(JSON Schema);manager 转 zod 后注册。 */
  inputSchema: unknown;
}
