import { describe, it, expect } from "vitest";
import { truncate } from "../../src/preprocess/truncate.js";

describe("truncate", () => {
  it("returns content unchanged when below budget", () => {
    const res = truncate("hello world", { budgetBytes: 1024 });
    expect(res.truncated).toBe(false);
    expect(res.content).toBe("hello world");
    expect(res.omittedBytes).toBe(0);
  });

  it("truncates with head+tail when above budget", () => {
    const content = "A".repeat(1000) + "MIDDLE" + "B".repeat(1000);
    const res = truncate(content, { budgetBytes: 200 });
    expect(res.truncated).toBe(true);
    expect(res.omittedBytes).toBeGreaterThan(0);
    // Head A's and tail B's must both appear; middle does not.
    expect(res.content).toContain("A");
    expect(res.content).toContain("B");
    expect(res.content).toContain("omitted");
  });

  it("does not split utf-8 multi-byte characters", () => {
    // 中文每字符 3 字节;长度 3000 bytes
    const content = "中".repeat(1000);
    const res = truncate(content, { budgetBytes: 600, alignToLine: false });
    expect(res.truncated).toBe(true);
    // 头部分仅含完整字符
    const head = res.content.split("...")[0];
    expect(head.match(/中/g)?.length ?? 0).toBeGreaterThan(0);
    // 无替代字符(切坏 utf-8 会产出 U+FFFD)
    expect(res.content).not.toMatch(/�/);
  });
});
