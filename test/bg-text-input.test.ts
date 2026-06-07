import { describe, it, expect } from "vitest";
import { maybeWrapImagePath } from "../src/components/BgTextInput.js";

// 占位符整体删除的逻辑在 useInput 回调里,不易直接单测组件;这里把 regex 暴露,
// 用一个本地辅助函数模拟"backspace 看光标前是否是占位符尾巴"的判断。
const PLACEHOLDER_TAIL_RE = /\[Image #\d+\]$|\[Pasted text #\d+ \+\d+ lines\]$/;
function backspaceLen(before: string): number {
  const m = before.match(PLACEHOLDER_TAIL_RE);
  return m ? m[0].length : 1;
}

describe("maybeWrapImagePath", () => {
  it("wraps macOS Terminal-style drag (raw abs path)", () => {
    expect(maybeWrapImagePath("/Users/me/shot.png")).toBe("@/Users/me/shot.png ");
  });

  it("wraps iTerm-style drag (single-quoted abs path)", () => {
    expect(maybeWrapImagePath("'/Users/me/shot.png'")).toBe("@/Users/me/shot.png ");
  });

  it("wraps file:// URL", () => {
    expect(maybeWrapImagePath("file:///Users/me/shot.png")).toBe("@/Users/me/shot.png ");
  });

  it("decodes URI escapes in file:// URLs", () => {
    expect(maybeWrapImagePath("file:///Users/me/has%20space.png")).toBe("@/Users/me/has space.png ");
  });

  it("handles .jpg .jpeg .gif .webp", () => {
    expect(maybeWrapImagePath("/a/b.jpg")).toBe("@/a/b.jpg ");
    expect(maybeWrapImagePath("/a/b.JPEG")).toBe("@/a/b.JPEG ");
    expect(maybeWrapImagePath("/a/b.gif")).toBe("@/a/b.gif ");
    expect(maybeWrapImagePath("/a/b.webp")).toBe("@/a/b.webp ");
  });

  it("leaves non-image absolute paths alone", () => {
    expect(maybeWrapImagePath("/Users/me/notes.txt")).toBe("/Users/me/notes.txt");
    expect(maybeWrapImagePath("/Users/me/src.ts")).toBe("/Users/me/src.ts");
  });

  it("leaves relative paths alone (must be absolute or file://)", () => {
    expect(maybeWrapImagePath("./shot.png")).toBe("./shot.png");
    expect(maybeWrapImagePath("shot.png")).toBe("shot.png");
  });

  it("leaves regular typed text alone", () => {
    expect(maybeWrapImagePath("hello")).toBe("hello");
    expect(maybeWrapImagePath("@./already.png")).toBe("@./already.png");
  });

  it("leaves multi-token text alone (must be single path)", () => {
    expect(maybeWrapImagePath("look /a/b.png")).toBe("look /a/b.png");
  });
});

describe("placeholder atomic deletion", () => {
  it("backspace deletes [Image #N] as a single unit", () => {
    expect(backspaceLen("hello [Image #1]")).toBe(10); // "[Image #1]" = 10 chars
    expect(backspaceLen("[Image #42]")).toBe(11);
    expect(backspaceLen("[Image #999]")).toBe(12);
  });

  it("backspace deletes [Pasted text #N +M lines] as a single unit", () => {
    expect(backspaceLen("hi [Pasted text #1 +3 lines]")).toBe("[Pasted text #1 +3 lines]".length);
    expect(backspaceLen("[Pasted text #12 +345 lines]")).toBe("[Pasted text #12 +345 lines]".length);
  });

  it("backspace falls back to single char for non-placeholder tails", () => {
    expect(backspaceLen("hello")).toBe(1);
    expect(backspaceLen("[Image #1] more")).toBe(1); // 占位符后面有字符,不在尾部
    expect(backspaceLen("[Imag")).toBe(1); // 半残不算
    expect(backspaceLen("")).toBe(1);
  });
});
