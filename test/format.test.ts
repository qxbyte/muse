import { describe, it, expect } from "vitest";
import { parseArgs, parseModelSpec } from "../src/slash/_format.js";

describe("parseArgs", () => {
  it("parses --flag value", () => {
    const { flags, positional } = parseArgs("--keep 8");
    expect(flags.keep).toBe("8");
    expect(positional).toEqual([]);
  });

  it("treats boolean flags", () => {
    const { flags } = parseArgs("--debug --verbose");
    expect(flags.debug).toBe(true);
    expect(flags.verbose).toBe(true);
  });

  it("keeps positional separate", () => {
    const { flags, positional } = parseArgs("--keep 8 foo bar");
    expect(flags.keep).toBe("8");
    expect(positional).toEqual(["foo", "bar"]);
  });
});

describe("parseModelSpec", () => {
  it("parses provider/model", () => {
    expect(parseModelSpec("openai/gpt-4o", "fallback")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("uses fallback provider when no slash", () => {
    expect(parseModelSpec("gpt-4o-mini", "deepseek")).toEqual({ provider: "deepseek", model: "gpt-4o-mini" });
  });
});
