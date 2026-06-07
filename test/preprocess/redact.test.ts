import { describe, it, expect } from "vitest";
import { redact, DEFAULT_RULES } from "../../src/preprocess/redact.js";

describe("redact", () => {
  it("masks OpenAI keys", () => {
    const input = "use this key: sk-" + "a".repeat(48) + " end";
    const { content, hits } = redact(input);
    expect(content).toContain("[REDACTED:openai-key]");
    expect(hits.find((h) => h.rule === "openai-key")?.count).toBe(1);
  });

  it("masks Anthropic keys", () => {
    const input = "sk-ant-" + "x".repeat(50);
    const { content, hits } = redact(input);
    expect(content).toContain("[REDACTED:anthropic-key]");
    expect(hits.find((h) => h.rule === "anthropic-key")?.count).toBe(1);
  });

  it("masks GitHub PAT", () => {
    const input = "token=ghp_" + "y".repeat(36);
    const { content, hits } = redact(input);
    expect(content).toContain("[REDACTED:github-pat]");
    expect(hits.find((h) => h.rule === "github-pat")?.count).toBe(1);
  });

  it("masks PEM private key blocks", () => {
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\nfoo bar baz\n-----END OPENSSH PRIVATE KEY-----`;
    const { content, hits } = redact(`prefix ${pem} suffix`);
    expect(content).toContain("[REDACTED:private-key-block]");
    expect(hits.find((h) => h.rule === "private-key-block")?.count).toBe(1);
    expect(content).toContain("prefix");
    expect(content).toContain("suffix");
  });

  it("returns content unchanged when no rule matches", () => {
    const input = "nothing sensitive here, just text.";
    const { content, hits } = redact(input);
    expect(content).toBe(input);
    expect(hits).toEqual([]);
  });

  it("uses default rules when none provided", () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(3);
  });
});
