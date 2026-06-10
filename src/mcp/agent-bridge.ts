/**
 * MCP ↔ Agent loop 的 permission 桥接。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.7。
 *
 * MCP tool 的权限决策与内置工具不同:trust=auto 时直接放行(server 自治),
 * trust=deny 时直接拒绝,trust=ask(默认)走普通 PermissionGate。
 *
 * 抽出来让 agent.ts 单文件不再膨胀(CLAUDE.md 模块化规则);通过参数化纯函数,
 * 不依赖 Agent 类内部字段,易测试。
 */

import type { Decision, PermissionGate } from "../permission/index.js";
import type { PermissionLevel } from "../tools/types.js";
import type { MCPManager } from "./manager.js";

export interface MCPDecideInput {
  toolName: string;
  args: unknown;
  permission?: PermissionLevel;
}

/**
 * MCP-aware 权限决策:
 *   1. 不是 mcp__* 工具名 → 直接走 PermissionGate.decide(原行为)
 *   2. 是 mcp__* 工具 + server trust=auto → "allow"(不询问)
 *   3. 是 mcp__* 工具 + server trust=deny → "deny"
 *   4. 是 mcp__* 工具 + server trust=ask(默认或未设) → PermissionGate.decide(走普通流程)
 *
 * 注意:即使 server trust=auto,**plan 模式**仍由 PermissionGate 决定可见工具集
 * (通过 toolRegistry.toLLMDefinitions filter),所以"绕过 decide"不会让 plan 模式失守。
 */
export function decideMCPOrPlain(
  gate: PermissionGate,
  manager: MCPManager | undefined,
  input: MCPDecideInput,
): Decision {
  if (!manager) return gate.decide(input);
  const parsed = manager.parseQualifiedName(input.toolName);
  if (!parsed) return gate.decide(input);
  const trust = manager.getTrust(parsed.serverName) ?? "ask";
  if (trust === "auto") return "allow";
  if (trust === "deny") return "deny";
  return gate.decide(input);
}
