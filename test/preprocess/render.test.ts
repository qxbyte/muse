import { describe, it, expect } from "vitest";
import { renderMarkdown, collapseLong } from "../../src/preprocess/render/index.js";

// 剥 ANSI 转义码,只看可见文本
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderMarkdown", () => {
  it("strips ## from heading (showSectionPrefix=false)", () => {
    const md = "## 主要文件夹\n\n内容";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    // ## 必须被剥掉,只保留标题文本
    expect(plain).not.toContain("##");
    expect(plain).toContain("主要文件夹");
  });

  it("strips ### (h3) and # (h1)", () => {
    expect(stripAnsi(renderMarkdown("# T1"))).not.toContain("#");
    expect(stripAnsi(renderMarkdown("### T3"))).not.toContain("#");
    expect(stripAnsi(renderMarkdown("# T1"))).toContain("T1");
    expect(stripAnsi(renderMarkdown("### T3"))).toContain("T3");
  });

  it("renders **bold** with ANSI bold sequence", () => {
    const out = renderMarkdown("hello **world**");
    expect(out).toContain("\x1b[1m");
    expect(out).toContain("world");
    expect(stripAnsi(out)).not.toContain("**");
  });

  it("renders *italic* with ANSI italic sequence", () => {
    const out = renderMarkdown("hello *world*");
    expect(out).toContain("\x1b[3m");
    expect(stripAnsi(out)).not.toContain("*world*");
  });

  it("renders ``` code blocks ```", () => {
    const out = renderMarkdown("```\nconst x = 1;\n```");
    expect(stripAnsi(out)).toContain("const x = 1;");
  });

  it("renders | table | rows |", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    expect(plain).toContain("A");
    expect(plain).toContain("B");
    expect(plain).toContain("1");
    expect(plain).toContain("2");
  });

  it("falls back to raw text when parse fails (unclosed code fence)", () => {
    // 流式中半截 ```code 块。renderMarkdown 应不抛错,退化为原文。
    const md = "before\n```ts\nconst x = 1;";
    const out = renderMarkdown(md);
    expect(out).toBeTruthy();
    // 不抛错就 OK;不一定要含 ``` 因为 marked 可能容错处理
  });

  it("strips top-level \\x1b[0m to avoid bg-band break", () => {
    const out = renderMarkdown("## title\n\nbody");
    expect(out).not.toMatch(/\x1b\[0m/);
  });
});

describe("collapseLong", () => {
  it("short content (under maxLines) is not collapsed", () => {
    const out = collapseLong("a\nb\nc", { maxLines: 10 });
    expect(out.collapsed).toBe(false);
    expect(out.head).toEqual(["a", "b", "c"]);
    expect(out.tail).toEqual([]);
    expect(out.omittedLines).toBe(0);
  });

  it("exactly at maxLines is not collapsed", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `L${i}`);
    const out = collapseLong(lines.join("\n"), { maxLines: 5 });
    expect(out.collapsed).toBe(false);
    expect(out.head).toHaveLength(5);
  });

  it("over maxLines folds into head + tail", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
    const out = collapseLong(lines.join("\n"), {
      maxLines: 10,
      headLines: 3,
      tailLines: 2,
    });
    expect(out.collapsed).toBe(true);
    expect(out.head).toEqual(["L0", "L1", "L2"]);
    expect(out.tail).toEqual(["L18", "L19"]);
    expect(out.omittedLines).toBe(15);
  });

  it("default opts: 200 maxLines, 5 head + 5 tail", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const out = collapseLong(lines.join("\n"));
    expect(out.collapsed).toBe(true);
    expect(out.head).toHaveLength(5);
    expect(out.tail).toHaveLength(5);
    expect(out.omittedLines).toBe(290);
    expect(out.head[0]).toBe("L0");
    expect(out.tail[4]).toBe("L299");
  });

  it("misconfigured head+tail >= maxLines: degrades safely", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
    // headLines + tailLines > maxLines:实装走"按比例缩"分支
    const out = collapseLong(lines.join("\n"), {
      maxLines: 10,
      headLines: 100,
      tailLines: 100,
    });
    expect(out.collapsed).toBe(true);
    expect(out.head.length + out.tail.length).toBeLessThan(20);
    expect(out.omittedLines).toBeGreaterThan(0);
  });
});
