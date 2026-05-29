/**
 * 自带背景色的轻量输入组件，替换 ink-text-input。
 *
 * Why：Ink 的 Box 不支持 backgroundColor 属性（只有 Text 支持），
 * 而 ink-text-input 输出的 Text 不暴露 bg 注入口。要实现"整行高亮背景"
 * 的输入条（对齐 Claude Code 风格），最干净的方式是自己渲染。
 *
 * 实现：单个 Text 节点，padEnd 到 width 让 bg 填满整行。
 * 光标用 inverse 字符表示，超出 width 时做左侧 viewport 裁切常驻光标可见。
 *
 * 终端列宽口径：用 charWidth() 处理 CJK / 全角等 2 列字符，避免内容超 width
 * 时换行（换行让 Ink 渲染高度变化，引起上面内容被顶上去——非常显眼的 bug）。
 *
 * 不支持：多行、IME 复合输入、emoji 代理对的精确光标位置——v0.1 范围。
 */

import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";

export interface BgTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** 主体内容可用宽度（"› " 这种前缀外），用于 padEnd 让 bg 填满整行。 */
  width: number;
  /** Tailwind 风 hex 或 Ink 颜色名。 */
  backgroundColor: string;
  /** 前景文字颜色；不传时用终端默认。 */
  color?: string;
  /** 是否启用键盘（弹模态时调用方传 false 让出键盘所有权）。 */
  isActive?: boolean;
}

export function BgTextInput({
  value,
  onChange,
  onSubmit,
  width,
  backgroundColor,
  color,
  isActive = true,
}: BgTextInputProps) {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    // value 外部改变（commitInput / remount）时把光标移到末尾或夹在合法范围
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        onChange(next);
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      // 不消费 Ctrl+C / Shift+Tab / ↑↓ / Tab / Esc / meta——交给 App 顶层 useInput
      if (key.ctrl || key.shift || key.tab || key.escape || key.upArrow || key.downArrow || key.meta) {
        return;
      }
      // 普通字符（含粘贴）：在光标处插入
      if (input && !key.return) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        onChange(next);
        setCursor((c) => c + input.length);
      }
    },
    { isActive },
  );

  // 视口计算：保证整行可视宽度 == width，光标永远可见
  const view = computeViewport(value, cursor, width);
  const at = view.atChar;
  const padLen = Math.max(0, width - view.consumedWidth);

  return (
    <Text backgroundColor={backgroundColor} color={color}>
      {view.before}
      <Text backgroundColor={backgroundColor} color={color} inverse>
        {at}
      </Text>
      {view.after}
      {" ".repeat(padLen)}
    </Text>
  );
}

// ---------- helpers ----------

/** 估计单字符在终端的列宽：CJK / 全角 = 2，控制符 = 0，其余 = 1。 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20 || cp === 0x7f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / CJK Symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth ASCII / Punctuation
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Sign
    (cp >= 0x20000 && cp <= 0x2fffd) // CJK Ext B–F
  ) {
    return 2;
  }
  return 1;
}

function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

interface Viewport {
  before: string;
  atChar: string;
  after: string;
  consumedWidth: number;
}

/**
 * 计算视口：保证渲染宽度 == width，光标永远在可视范围内。
 * 溢出时从左侧裁掉字符让窗口右沿吃下光标。
 */
function computeViewport(value: string, cursor: number, width: number): Viewport {
  const cursorAtEnd = cursor >= value.length;
  const atChar = cursorAtEnd ? " " : value[cursor] ?? " ";
  const cursorCellW = charWidth(atChar);

  // 尝试用全量 [0, cursor) + cursor cell + (cursor+1, end] 渲染
  // 若总宽度 > width，从 before 左侧逐字符裁掉
  let beforeStart = 0;
  while (true) {
    const before = value.slice(beforeStart, cursor);
    const after = cursorAtEnd ? "" : value.slice(cursor + 1);
    const total = stringWidth(before) + cursorCellW + stringWidth(after);
    if (total <= width) {
      return { before, atChar, after, consumedWidth: total };
    }
    if (beforeStart >= cursor) {
      // before 已经全裁完仍超：再从 after 尾部裁
      // （cursor 后面有超长内容；少见，但 paste 一大段会触发）
      let after = cursorAtEnd ? "" : value.slice(cursor + 1);
      while (after.length > 0 && stringWidth("") + cursorCellW + stringWidth(after) > width) {
        after = after.slice(0, -1);
      }
      return {
        before: "",
        atChar,
        after,
        consumedWidth: cursorCellW + stringWidth(after),
      };
    }
    beforeStart++;
  }
}
