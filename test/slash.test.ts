import { describe, it, expect } from "vitest";
import { SlashRegistry, parseSlash } from "../src/slash/registry.js";
import type { SlashCommand } from "../src/slash/types.js";

describe("parseSlash", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlash("hello world")).toBeNull();
    expect(parseSlash("")).toBeNull();
    expect(parseSlash(" ")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });

  it("parses bare command", () => {
    expect(parseSlash("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlash("/model gpt-4o")).toEqual({ name: "model", args: "gpt-4o" });
  });

  it("normalizes leading/trailing whitespace", () => {
    expect(parseSlash("  /help  ")).toEqual({ name: "help", args: "" });
    expect(parseSlash("/model   gpt-4o   ")).toEqual({ name: "model", args: "gpt-4o" });
  });

  it("supports multi-token args verbatim", () => {
    expect(parseSlash("/compact --keep 8")).toEqual({ name: "compact", args: "--keep 8" });
  });
});

describe("SlashRegistry", () => {
  const dummy: SlashCommand = {
    name: "foo",
    aliases: ["fo"],
    description: "test",
    execute: () => ({ display: "ok" }),
  };

  it("register + get", () => {
    const r = new SlashRegistry();
    r.register(dummy);
    expect(r.get("foo")).toBe(dummy);
    expect(r.get("fo")).toBe(dummy);
    expect(r.get("missing")).toBeUndefined();
  });

  it("throws on duplicate name", () => {
    const r = new SlashRegistry();
    r.register(dummy);
    expect(() => r.register(dummy)).toThrow(/Duplicate/);
  });

  it("list preserves registration order; aliases not duplicated", () => {
    const r = new SlashRegistry();
    r.register(dummy);
    r.register({ ...dummy, name: "bar", aliases: undefined });
    const names = r.list().map((c) => c.name);
    expect(names).toEqual(["foo", "bar"]);
  });
});
