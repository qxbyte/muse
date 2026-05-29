import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { expandEnvVars } from "../src/config/_env.js";

describe("expandEnvVars", () => {
  beforeAll(() => {
    process.env.MUSE_TEST_VAR = "hello";
  });
  afterAll(() => {
    delete process.env.MUSE_TEST_VAR;
  });

  it("expands ${VAR} in strings", () => {
    expect(expandEnvVars("v=${MUSE_TEST_VAR}")).toBe("v=hello");
  });

  it("missing var → empty string", () => {
    expect(expandEnvVars("v=${MUSE_MISSING_VAR}")).toBe("v=");
  });

  it("recurses through objects and arrays", () => {
    const got = expandEnvVars({
      a: "${MUSE_TEST_VAR}",
      b: [{ c: "${MUSE_TEST_VAR}!" }, 42, "literal"],
    });
    expect(got).toEqual({
      a: "hello",
      b: [{ c: "hello!" }, 42, "literal"],
    });
  });

  it("leaves non-string scalars intact", () => {
    expect(expandEnvVars(42)).toBe(42);
    expect(expandEnvVars(true)).toBe(true);
    expect(expandEnvVars(null)).toBeNull();
  });
});
