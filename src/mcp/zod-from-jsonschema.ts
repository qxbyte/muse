/**
 * 极简 JSON Schema → zod 转换。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.6。
 *
 * MCP server 用 JSON Schema 声明 tool 的 inputSchema;muse 用 zod 做 ToolRegistry
 * 参数校验。第三方库(zod-from-json-schema 等)依赖偏重 + 形态多变;**MCP 实际只用
 * 一个很小的 JSON Schema 子集**(object / string / number / boolean / array / enum /
 * required / description),手写一个 ~150 行 helper 比引依赖更稳。
 *
 * 不支持的高级特性(allOf / anyOf / oneOf / $ref / nested 复合)→ 退化为
 * `z.unknown()`(允许任意值通过 zod,延后由 server 自己校验报错)。
 */

import { z, type ZodTypeAny } from "zod";

/** JSON Schema 顶层期望是 object;如果不是 → 整体退化为 z.unknown()。 */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!isPlainObject(schema)) return z.unknown();
  return convertNode(schema as JsonSchemaNode);
}

// ============================== 内部实现 ==============================

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  /** 我们识别但仅做记录的高级字段 — 命中时整体退化。 */
  allOf?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  $ref?: string;
}

function convertNode(node: JsonSchemaNode): ZodTypeAny {
  // 不支持的复合 → 退化
  if (node.allOf || node.anyOf || node.oneOf || node.$ref) return z.unknown();

  // enum 优先(无论 type 是什么)
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return convertEnum(node.enum);
  }
  if (node.const !== undefined) return z.literal(node.const as never);

  const type = node.type;
  if (typeof type === "string") return convertByType(type, node);
  // type 是数组(union 类型,如 ["string","null"])— 简单处理:第一个 type
  if (Array.isArray(type) && type.length > 0) return convertByType(type[0], node);

  // 无 type — 兜底
  return z.unknown();
}

function convertByType(type: string, node: JsonSchemaNode): ZodTypeAny {
  switch (type) {
    case "string":
      return applyStringConstraints(z.string(), node);
    case "number":
    case "integer":
      return applyNumberConstraints(type === "integer" ? z.number().int() : z.number(), node);
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return convertArray(node);
    case "object":
      return convertObject(node);
    default:
      return z.unknown();
  }
}

function convertEnum(values: unknown[]): ZodTypeAny {
  // zod 的 enum 只支持 string 字面量;非 string 退化为 union of literals
  if (values.every((v) => typeof v === "string")) {
    return z.enum(values as [string, ...string[]]);
  }
  const literals = values.map((v) => z.literal(v as never));
  if (literals.length === 1) return literals[0];
  return z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function applyStringConstraints(s: z.ZodString, node: JsonSchemaNode): ZodTypeAny {
  let out: ZodTypeAny = s;
  if (typeof node.minLength === "number") out = (out as z.ZodString).min(node.minLength);
  if (typeof node.maxLength === "number") out = (out as z.ZodString).max(node.maxLength);
  return withDescription(out, node);
}

function applyNumberConstraints(n: z.ZodNumber, node: JsonSchemaNode): ZodTypeAny {
  let out: ZodTypeAny = n;
  if (typeof node.minimum === "number") out = (out as z.ZodNumber).min(node.minimum);
  if (typeof node.maximum === "number") out = (out as z.ZodNumber).max(node.maximum);
  return withDescription(out, node);
}

function convertArray(node: JsonSchemaNode): ZodTypeAny {
  const items = node.items;
  if (items === undefined) return z.array(z.unknown());
  if (Array.isArray(items)) return z.array(z.unknown()); // tuple 形态退化
  return z.array(convertNode(items));
}

function convertObject(node: JsonSchemaNode): ZodTypeAny {
  const props = node.properties;
  if (!props || Object.keys(props).length === 0) {
    // 空对象 / 没声明 properties — passthrough
    return z.record(z.unknown());
  }
  const required = new Set(node.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(props)) {
    const fieldSchema = convertNode(sub);
    shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
  }
  return z.object(shape).passthrough();
}

function withDescription(schema: ZodTypeAny, node: JsonSchemaNode): ZodTypeAny {
  return node.description ? schema.describe(node.description) : schema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
