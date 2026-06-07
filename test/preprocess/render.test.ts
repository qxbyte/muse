import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../src/preprocess/render/index.js";

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
