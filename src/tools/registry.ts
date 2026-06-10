/**
 * 工具注册中心：管理所有可用工具，提供查询、调用、转 LLM-tool-definition 的能力。
 */

import { z } from "zod";
import type { AnyTool, ToolContext, ToolExecuteResult } from "./types.js";
import type { ToolDefinition as LLMToolDefinition } from "../types/index.js";
import { ToolError } from "../types/index.js";

/** zod schema → JSON Schema (subset)。仅覆盖 v0.1 需要的类型。 */
function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;

  if (def.typeName === "ZodObject") {
    const shape = (schema as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType<unknown>);
      if (!(value as unknown as { isOptional?: () => boolean }).isOptional?.()) {
        required.push(key);
      }
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  if (def.typeName === "ZodString") {
    const d = def as unknown as { description?: string };
    return { type: "string", ...(d.description ? { description: d.description } : {}) };
  }

  if (def.typeName === "ZodNumber") {
    return { type: "number" };
  }

  if (def.typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (def.typeName === "ZodArray") {
    const inner = (def as unknown as { type: z.ZodType<unknown> }).type;
    return { type: "array", items: zodToJsonSchema(inner) };
  }

  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    const inner = (def as unknown as { innerType: z.ZodType<unknown> }).innerType;
    return zodToJsonSchema(inner);
  }

  if (def.typeName === "ZodEnum") {
    const values = (def as unknown as { values: string[] }).values;
    return { type: "string", enum: values };
  }

  if (def.typeName === "ZodUnion") {
    const opts = (def as unknown as { options: z.ZodType<unknown>[] }).options;
    return { anyOf: opts.map(zodToJsonSchema) };
  }

  // Fallback: 任意类型
  return {};
}

function getDescription(schema: z.ZodType<unknown>): string | undefined {
  return (schema as unknown as { description?: string }).description;
}

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: AnyTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  /**
   * 移除工具(MCP server disconnect / reconnect 时回收 mcp__* 工具)。
   * 不存在 → 返 false(允许幂等调用)。
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return Array.from(this.tools.values());
  }

  /** 转为 LLM 可读的 tool definition 数组。可选 filter（如 plan 模式过滤只读工具）。 */
  toLLMDefinitions(filter?: (tool: AnyTool) => boolean): LLMToolDefinition[] {
    let tools = this.list();
    if (filter) tools = tools.filter(filter);
    return tools.map((t) => {
      const schema = zodToJsonSchema(t.parameters);
      // 顶层描述：从 zod schema 的 .describe 拿
      const desc = getDescription(t.parameters);
      if (desc && typeof schema === "object" && schema !== null) {
        (schema as Record<string, unknown>).description = desc;
      }
      return {
        name: t.name,
        description: t.description,
        parameters: schema,
      };
    });
  }

  /** 调用工具：校验参数 → 执行。 */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolExecuteResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`Tool "${name}" not found.`, name);
    }
    const parseResult = tool.parameters.safeParse(rawArgs);
    if (!parseResult.success) {
      return {
        content: `Invalid arguments for ${name}: ${parseResult.error.message}`,
        isError: true,
      };
    }
    try {
      return await tool.execute(parseResult.data, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Tool ${name} threw: ${msg}`, isError: true };
    }
  }
}
