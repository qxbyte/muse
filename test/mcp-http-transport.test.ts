/**
 * MCP HTTP transport(v0.3.x)配置 / 判定 / manager 接入测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.1 / §十(v0.3.x)。
 *
 * 不连真 server:聚焦 transport 判定纯逻辑 + schema 校验 + manager 对 http server
 * 的 status / trust / 互斥校验处理。真 SDK 连接路径由集成环境覆盖。
 */

import { describe, it, expect } from "vitest";
import {
  MCPServerConfigSchema,
  resolveTransportKind,
  type MCPServerConfig,
} from "../src/mcp/types.js";
import { MCPManager } from "../src/mcp/manager.js";
import { ToolRegistry } from "../src/tools/registry.js";

function mkManager(servers: Record<string, MCPServerConfig>): MCPManager {
  const manager = new MCPManager({ servers, toolRegistry: new ToolRegistry() });
  manager.init();
  return manager;
}

describe("resolveTransportKind", () => {
  it("有 command → stdio", () => {
    expect(resolveTransportKind("s", { command: "npx" })).toBe("stdio");
  });

  it("有 url → http", () => {
    expect(resolveTransportKind("s", { url: "https://mcp.example.com/v1" })).toBe("http");
  });

  it("command 与 url 同时有 → 抛(互斥)", () => {
    expect(() => resolveTransportKind("s", { command: "npx", url: "https://x.com" })).toThrow(/mutually exclusive/);
  });

  it("两者都没有 → 抛", () => {
    expect(() => resolveTransportKind("s", {})).toThrow(/either 'command'.*or 'url'/);
  });
});

describe("MCPServerConfigSchema — HTTP 字段", () => {
  it("接受 url + headers", () => {
    const c = MCPServerConfigSchema.parse({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
      trust: "ask",
    });
    expect(c.url).toBe("https://mcp.example.com/mcp");
    expect(c.headers?.Authorization).toBe("Bearer tok");
  });

  it("非法 url → schema 报错", () => {
    expect(() => MCPServerConfigSchema.parse({ url: "not-a-url" })).toThrow();
  });

  it("stdio 配置不受影响(无 url 仍合法)", () => {
    const c = MCPServerConfigSchema.parse({ command: "uvx", args: ["mcp-server-git"] });
    expect(c.command).toBe("uvx");
    expect(c.url).toBeUndefined();
  });
});

describe("MCPManager — HTTP server 接入", () => {
  it("http server 进 status,connected=false(懒)", () => {
    const manager = mkManager({
      remote: { url: "https://mcp.example.com/mcp", trust: "ask" },
    });
    const s = manager.status();
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("remote");
    expect(s[0].connected).toBe(false);
    expect(s[0].config?.url).toBe("https://mcp.example.com/mcp");
  });

  it("http server namespace override 生效", () => {
    const manager = mkManager({
      "remote-git": { url: "https://x.com/mcp", namespace: "git" },
    });
    expect(manager.status()[0].namespace).toBe("git");
    expect(manager.parseQualifiedName("mcp__git__commit")).toEqual({
      serverName: "remote-git",
      rawTool: "commit",
    });
  });

  it("http server trust=deny → invoke 直接 reject 不连接", async () => {
    const manager = mkManager({
      remote: { url: "https://x.com/mcp", trust: "deny" },
    });
    const r = await manager.invoke("mcp__remote__list", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/trust=deny/);
  });

  it("stdio 与 http server 混配,各自独立", () => {
    const manager = mkManager({
      local: { command: "npx", args: ["x"] },
      remote: { url: "https://x.com/mcp" },
    });
    expect(manager.status().map((x) => x.name).sort()).toEqual(["local", "remote"]);
  });
});
