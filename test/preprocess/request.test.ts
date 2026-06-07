import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RequestPipeline, createRequestCtx } from "../../src/preprocess/request/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/types.js";
import { TodoStore } from "../../src/loop/todos.js";

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: "Read",
      description: "Read a file.",
      parameters: z.object({ path: z.string() }),
      permission: "read",
      execute: async () => ({ content: "ok" }),
    }),
  );
  reg.register(
    defineTool({
      name: "Write",
      description: "Write a file.",
      parameters: z.object({ path: z.string(), content: z.string() }),
      permission: "write",
      execute: async () => ({ content: "ok" }),
    }),
  );
  return reg;
}

describe("RequestPipeline", () => {
  it("builds system prompt + tools in default mode", async () => {
    const reg = buildRegistry();
    const ctx = createRequestCtx({
      messages: [],
      modelId: "test-model",
      mode: "default",
      cwd: process.cwd(),
      services: {
        todos: new TodoStore(),
        memoryIndex: "",
        toolRegistry: reg,
        provider: "test-provider",
      },
    });
    await RequestPipeline().run(ctx);
    expect(ctx.systemPrompt).toContain("Muse");
    expect(ctx.tools.map((t) => t.name).sort()).toEqual(["Read", "Write"]);
  });

  it("plan mode filters tools to read-only", async () => {
    const reg = buildRegistry();
    const ctx = createRequestCtx({
      messages: [],
      modelId: "m",
      mode: "plan",
      cwd: process.cwd(),
      services: {
        todos: new TodoStore(),
        memoryIndex: "",
        toolRegistry: reg,
        provider: "p",
      },
    });
    await RequestPipeline().run(ctx);
    expect(ctx.tools.map((t) => t.name)).toEqual(["Read"]);
    expect(ctx.systemPrompt).toContain("Plan mode");
  });

  it("injects todos into system prompt", async () => {
    const todos = new TodoStore();
    todos.set([{ content: "fix the bug", status: "in_progress" }]);
    const ctx = createRequestCtx({
      messages: [],
      modelId: "m",
      mode: "default",
      cwd: process.cwd(),
      services: {
        todos,
        memoryIndex: "",
        toolRegistry: buildRegistry(),
        provider: "p",
      },
    });
    await RequestPipeline().run(ctx);
    expect(ctx.systemPrompt).toContain("fix the bug");
    expect(ctx.systemPrompt).toContain("Current todos");
  });

  it("injects memoryIndex into system prompt", async () => {
    const ctx = createRequestCtx({
      messages: [],
      modelId: "m",
      mode: "default",
      cwd: process.cwd(),
      services: {
        todos: new TodoStore(),
        memoryIndex: "- [user role](user_role.md) — TypeScript engineer",
        toolRegistry: buildRegistry(),
        provider: "p",
      },
    });
    await RequestPipeline().run(ctx);
    expect(ctx.systemPrompt).toContain("Memory (long-term)");
    expect(ctx.systemPrompt).toContain("user role");
  });
});
