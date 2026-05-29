import { describe, it, expect } from "vitest";
import { PermissionGate } from "../src/permission/index.js";

describe("PermissionGate.decide", () => {
  it("returns deny for matching deny pattern even in bypass mode", () => {
    const g = new PermissionGate({ deny: ["Write"] });
    g.setMode("bypassPermissions");
    expect(g.decide({ toolName: "Write", args: {} })).toBe("deny");
  });

  it("returns allow for matching allow pattern in default mode", () => {
    const g = new PermissionGate({ allow: ["Read"], defaultMode: "ask" });
    expect(g.decide({ toolName: "Read", args: {} })).toBe("allow");
  });

  it("returns ask when not matched and defaultMode=ask", () => {
    const g = new PermissionGate({ defaultMode: "ask" });
    expect(g.decide({ toolName: "Edit", args: {} })).toBe("ask");
  });

  it("plan mode allows only read tools", () => {
    const g = new PermissionGate({});
    g.setMode("plan");
    expect(g.decide({ toolName: "Read", args: {}, permission: "read" })).toBe("allow");
    expect(g.decide({ toolName: "Bash", args: {}, permission: "execute" })).toBe("deny");
    expect(g.decide({ toolName: "Edit", args: {}, permission: "write" })).toBe("deny");
  });

  it("acceptEdits auto-allows Edit and Write", () => {
    const g = new PermissionGate({ defaultMode: "ask" });
    g.setMode("acceptEdits");
    expect(g.decide({ toolName: "Edit", args: {} })).toBe("allow");
    expect(g.decide({ toolName: "Write", args: {} })).toBe("allow");
    expect(g.decide({ toolName: "Bash", args: {} })).toBe("ask");
  });

  it("matches Bash(prefix) for exact command", () => {
    const g = new PermissionGate({ allow: ["Bash(git status)"] });
    expect(g.decide({ toolName: "Bash", args: { command: "git status" } })).toBe("allow");
    expect(g.decide({ toolName: "Bash", args: { command: "git push" } })).toBe("ask");
  });

  it("matches Bash(prefix:*) for any subcommand", () => {
    const g = new PermissionGate({ allow: ["Bash(git:*)"] });
    expect(g.decide({ toolName: "Bash", args: { command: "git status" } })).toBe("allow");
    expect(g.decide({ toolName: "Bash", args: { command: "git log -n 5" } })).toBe("allow");
    expect(g.decide({ toolName: "Bash", args: { command: "rm something" } })).toBe("ask");
  });

  it("session_allow allows on subsequent decide", () => {
    const g = new PermissionGate({ defaultMode: "ask" });
    expect(g.decide({ toolName: "Bash", args: {} })).toBe("ask");
    g.allowForSession("Bash");
    expect(g.decide({ toolName: "Bash", args: {} })).toBe("allow");
  });

  it("session_allow is overridden by explicit deny", () => {
    const g = new PermissionGate({ deny: ["Bash"] });
    g.allowForSession("Bash");
    expect(g.decide({ toolName: "Bash", args: {} })).toBe("deny");
  });

  it("cycleMode walks the 4-mode ring", () => {
    const g = new PermissionGate({});
    expect(g.getMode()).toBe("default");
    expect(g.cycleMode()).toBe("acceptEdits");
    expect(g.cycleMode()).toBe("plan");
    expect(g.cycleMode()).toBe("bypassPermissions");
    expect(g.cycleMode()).toBe("default");
  });
});
