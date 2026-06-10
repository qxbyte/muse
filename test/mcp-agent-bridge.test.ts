/**
 * MCP ↔ Agent loop 桥接的 permission 决策单测。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.7。
 */

import { describe, it, expect } from "vitest";
import { decideMCPOrPlain } from "../src/mcp/agent-bridge.js";
import { MCPManager } from "../src/mcp/manager.js";
import { PermissionGate } from "../src/permission/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { MCPServerConfig } from "../src/mcp/types.js";

function mkManager(servers: Record<string, MCPServerConfig>): MCPManager {
  const m = new MCPManager({ servers, toolRegistry: new ToolRegistry() });
  m.init();
  return m;
}

describe("decideMCPOrPlain", () => {
  it("manager 未注入 → 走原 PermissionGate", () => {
    const gate = new PermissionGate({ allow: ["Read"] });
    const d = decideMCPOrPlain(gate, undefined, { toolName: "Read", args: {}, permission: "read" });
    expect(d).toBe("allow");
  });

  it("非 mcp 工具 → 走原 PermissionGate", () => {
    const gate = new PermissionGate({ allow: ["Read"] });
    const manager = mkManager({ fs: { command: "x" } });
    expect(decideMCPOrPlain(gate, manager, { toolName: "Read", args: {} })).toBe("allow");
  });

  it("mcp + trust=auto → 直接 allow,不走 gate", () => {
    const gate = new PermissionGate({ deny: ["Read"] }); // 即使内置 Read deny
    const manager = mkManager({ fs: { command: "x", trust: "auto" } });
    expect(decideMCPOrPlain(gate, manager, { toolName: "mcp__fs__list", args: {} })).toBe("allow");
  });

  it("mcp + trust=deny → 直接 deny,不走 gate", () => {
    const gate = new PermissionGate({ allow: ["mcp__fs__list"] });
    const manager = mkManager({ fs: { command: "x", trust: "deny" } });
    expect(decideMCPOrPlain(gate, manager, { toolName: "mcp__fs__list", args: {} })).toBe("deny");
  });

  it("mcp + trust=ask(默认)→ 走原 PermissionGate", () => {
    const gate = new PermissionGate({ allow: ["mcp__fs__list"] });
    const manager = mkManager({ fs: { command: "x", trust: "ask" } });
    expect(decideMCPOrPlain(gate, manager, { toolName: "mcp__fs__list", args: {} })).toBe("allow");
  });

  it("mcp + trust 未配 → fallback 到 ask(走原 gate)", () => {
    const gate = new PermissionGate({});
    const manager = mkManager({ fs: { command: "x" } });
    // 默认 defaultMode="ask",所以返 "ask"
    expect(decideMCPOrPlain(gate, manager, { toolName: "mcp__fs__list", args: {} })).toBe("ask");
  });

  it("mcp + trust=auto + 但 namespace 不存在 → fallback gate(因为 parseQualifiedName 返 null)", () => {
    const gate = new PermissionGate({ allow: ["mcp__unknown__x"] });
    const manager = mkManager({ fs: { command: "x", trust: "auto" } });
    // mcp__unknown__x 在 manager 找不到对应 server → 走 fallback gate
    expect(decideMCPOrPlain(gate, manager, { toolName: "mcp__unknown__x", args: {} })).toBe("allow");
  });
});
