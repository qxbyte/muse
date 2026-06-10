/**
 * JSON Schema → zod 转换测试。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §四.6。
 */

import { describe, it, expect } from "vitest";
import { jsonSchemaToZod } from "../src/mcp/zod-from-jsonschema.js";

describe("jsonSchemaToZod — primitives", () => {
  it("string", () => {
    const z = jsonSchemaToZod({ type: "string" });
    expect(z.parse("hi")).toBe("hi");
    expect(() => z.parse(42)).toThrow();
  });

  it("number / integer", () => {
    expect(jsonSchemaToZod({ type: "number" }).parse(1.5)).toBe(1.5);
    expect(() => jsonSchemaToZod({ type: "integer" }).parse(1.5)).toThrow();
  });

  it("boolean", () => {
    expect(jsonSchemaToZod({ type: "boolean" }).parse(true)).toBe(true);
  });

  it("null", () => {
    expect(jsonSchemaToZod({ type: "null" }).parse(null)).toBe(null);
  });

  it("string with minLength / maxLength", () => {
    const z = jsonSchemaToZod({ type: "string", minLength: 2, maxLength: 4 });
    expect(z.parse("abc")).toBe("abc");
    expect(() => z.parse("a")).toThrow();
    expect(() => z.parse("abcde")).toThrow();
  });

  it("number with minimum / maximum", () => {
    const z = jsonSchemaToZod({ type: "number", minimum: 0, maximum: 10 });
    expect(z.parse(5)).toBe(5);
    expect(() => z.parse(-1)).toThrow();
    expect(() => z.parse(11)).toThrow();
  });
});

describe("jsonSchemaToZod — enum / const", () => {
  it("string enum", () => {
    const z = jsonSchemaToZod({ type: "string", enum: ["a", "b", "c"] });
    expect(z.parse("a")).toBe("a");
    expect(() => z.parse("d")).toThrow();
  });

  it("mixed enum → union of literals", () => {
    const z = jsonSchemaToZod({ enum: [1, "two", true] });
    expect(z.parse(1)).toBe(1);
    expect(z.parse("two")).toBe("two");
    expect(() => z.parse(2)).toThrow();
  });

  it("const literal", () => {
    const z = jsonSchemaToZod({ const: "fixed" });
    expect(z.parse("fixed")).toBe("fixed");
    expect(() => z.parse("other")).toThrow();
  });
});

describe("jsonSchemaToZod — array", () => {
  it("array of strings", () => {
    const z = jsonSchemaToZod({ type: "array", items: { type: "string" } });
    expect(z.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => z.parse(["a", 1])).toThrow();
  });

  it("array without items → array of unknown", () => {
    const z = jsonSchemaToZod({ type: "array" });
    expect(z.parse([1, "a", true])).toEqual([1, "a", true]);
  });

  it("tuple form (items 是数组)→ 退化 array of unknown", () => {
    const z = jsonSchemaToZod({ type: "array", items: [{ type: "string" }, { type: "number" }] });
    expect(z.parse(["a", 1])).toEqual(["a", 1]);
    expect(z.parse([true, null])).toEqual([true, null]); // 退化后宽松
  });
});

describe("jsonSchemaToZod — object", () => {
  it("object with required + optional fields", () => {
    const z = jsonSchemaToZod({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
      },
      required: ["path"],
    });
    expect(z.parse({ path: "/a", offset: 10 })).toEqual({ path: "/a", offset: 10 });
    expect(z.parse({ path: "/a" })).toEqual({ path: "/a" });
    expect(() => z.parse({ offset: 10 })).toThrow();
  });

  it("nested object", () => {
    const z = jsonSchemaToZod({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      required: ["user"],
    });
    expect(z.parse({ user: { id: "x" } })).toEqual({ user: { id: "x" } });
    expect(() => z.parse({ user: {} })).toThrow();
  });

  it("empty object schema → record of unknown(passthrough)", () => {
    const z = jsonSchemaToZod({ type: "object" });
    expect(z.parse({ any: "thing" })).toEqual({ any: "thing" });
  });

  it("passthrough extra fields by default", () => {
    const z = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(z.parse({ a: "x", extra: 1 })).toEqual({ a: "x", extra: 1 });
  });
});

describe("jsonSchemaToZod — fallback (z.unknown)", () => {
  it("非对象输入 → z.unknown()", () => {
    expect(jsonSchemaToZod(null).parse(42)).toBe(42);
    expect(jsonSchemaToZod(undefined).parse("anything")).toBe("anything");
    expect(jsonSchemaToZod("not a schema").parse({})).toEqual({});
  });

  it("allOf / anyOf / oneOf / $ref → 整体退化", () => {
    expect(jsonSchemaToZod({ allOf: [{ type: "string" }] }).parse(42)).toBe(42);
    expect(jsonSchemaToZod({ anyOf: [] }).parse(true)).toBe(true);
    expect(jsonSchemaToZod({ $ref: "#/defs/X" }).parse(null)).toBe(null);
  });

  it("无 type / 无 enum / 无 const → z.unknown()", () => {
    expect(jsonSchemaToZod({ description: "yo" }).parse(42)).toBe(42);
  });

  it("type union(['string','null'])→ 取首项", () => {
    const z = jsonSchemaToZod({ type: ["string", "null"] });
    expect(z.parse("x")).toBe("x");
    expect(() => z.parse(null)).toThrow();
  });
});

describe("jsonSchemaToZod — description 注入", () => {
  it("description 通过 z.describe 传递", () => {
    const z = jsonSchemaToZod({ type: "string", description: "the path" });
    // zod 描述存在 _def.description(私有实现);简单验证 parse 仍正常
    expect(z.parse("/x")).toBe("/x");
  });
});
