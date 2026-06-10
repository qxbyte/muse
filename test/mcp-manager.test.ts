/**
 * MCPManager 行为测试(不依赖真 MCP server / SDK)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.4 / §四.5 / §四.7。
 *
 * 关键点验证:
 *   - 构造期仅记 manifest(不 spawn)
 *   - enabled=false 的 server 被忽略
 *   - 命名空间解析(`mcp__<ns>__<raw>` → server + rawTool)
 *   - trust=deny 直接 reject 不连接
 *   - 未连接时 invoke 触发懒连接(此处由于无真 SDK,期望走 SDK 缺失路径)
 */

import { describe, it, expect } from "vitest";
import { MCPManager } from "../src/mcp/manager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { MCPServerConfig } from "../src/mcp/types.js";

function mkManager(servers: Record<string, MCPServerConfig>): {
  manager: MCPManager;
  registry: ToolRegistry;
} {
  const registry = new ToolRegistry();
  const manager = new MCPManager({ servers, toolRegistry: registry });
  manager.init();
  return { manager, registry };
}

describe("MCPManager — 构造与 status", () => {
  it("空 servers → status 空", () => {
    const { manager } = mkManager({});
    expect(manager.status()).toEqual([]);
  });

  it("一个 stdio server → status 1 条,connected=false(懒)", () => {
    const { manager } = mkManager({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    });
    const s = manager.status();
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("fs");
    expect(s[0].namespace).toBe("fs");
    expect(s[0].connected).toBe(false);
    expect(s[0].toolCount).toBe(0);
  });

  it("enabled=false 的 server 被忽略", () => {
    const { manager } = mkManager({
      fs: { command: "x", enabled: false },
      git: { command: "uvx", args: ["mcp-server-git"] },
    });
    const s = manager.status();
    expect(s.map((x) => x.name)).toEqual(["git"]);
  });

  it("namespace override 生效", () => {
    const { manager } = mkManager({
      "my-fs": { command: "x", namespace: "fs" },
    });
    expect(manager.status()[0].namespace).toBe("fs");
  });
});

describe("MCPManager — parseQualifiedName", () => {
  it("正常 mcp__<ns>__<tool>", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.parseQualifiedName("mcp__fs__read_file")).toEqual({
      serverName: "fs",
      rawTool: "read_file",
    });
  });

  it("namespace 覆盖 — 用 namespace 不是 name", () => {
    const { manager } = mkManager({ "my-fs": { command: "x", namespace: "fs" } });
    expect(manager.parseQualifiedName("mcp__fs__list")).toEqual({
      serverName: "my-fs",
      rawTool: "list",
    });
    // 用 name 反而找不到(namespace 才是 LLM 看到的)
    expect(manager.parseQualifiedName("mcp__my-fs__list")).toBeNull();
  });

  it("不是 mcp__* 前缀 → null", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.parseQualifiedName("Read")).toBeNull();
    expect(manager.parseQualifiedName("mcp_fs_read")).toBeNull();
  });

  it("mcp__* 但 namespace 不存在 → null", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.parseQualifiedName("mcp__unknown__foo")).toBeNull();
  });

  it("缺 rawTool 部分 → null", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.parseQualifiedName("mcp__fs__")).toBeNull();
    expect(manager.parseQualifiedName("mcp__fs")).toBeNull();
  });

  it("rawTool 可含双下划线(只切第一个 __ 后的)", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.parseQualifiedName("mcp__fs__nested__name")).toEqual({
      serverName: "fs",
      rawTool: "nested__name",
    });
  });
});

describe("MCPManager — getTrust", () => {
  it("未配置 trust → undefined(走 ask 路径由 agent-bridge fallback)", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.getTrust("fs")).toBeUndefined();
  });

  it("auto / ask / deny 透传", () => {
    const { manager } = mkManager({
      a: { command: "x", trust: "auto" },
      b: { command: "x", trust: "ask" },
      c: { command: "x", trust: "deny" },
    });
    expect(manager.getTrust("a")).toBe("auto");
    expect(manager.getTrust("b")).toBe("ask");
    expect(manager.getTrust("c")).toBe("deny");
  });

  it("不存在的 server → undefined", () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    expect(manager.getTrust("nonexistent")).toBeUndefined();
  });
});

describe("MCPManager — invoke 入口校验(无 SDK / 错配置)", () => {
  it("非 mcp__ 工具名 → isError", async () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    const r = await manager.invoke("Read", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid MCP tool name/);
  });

  it("trust=deny → isError 不连接", async () => {
    const { manager } = mkManager({ fs: { command: "x", trust: "deny" } });
    const r = await manager.invoke("mcp__fs__list", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/trust=deny/);
  });

  it("不存在的 namespace → parseQualifiedName 失败 → isError", async () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    const r = await manager.invoke("mcp__unknown__foo", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid MCP tool name/);
  });
});

describe("MCPManager — shutdown 幂等", () => {
  it("无连接的 manager shutdown 不抛", async () => {
    const { manager } = mkManager({ fs: { command: "x" } });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});
