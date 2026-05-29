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
  /**
   * 检测到一段疑似粘贴（含换行 或 > 200 字符）时回调；返回的字符串作为实际插入内容
   * 替换原始 chunk。调用方一般注册原文到 paste registry，返回 `[Pasted text #N ...]`
   * 占位符，避免 \n 进入输入框造成多行渲染。
   */
  onPaste?: (chunk: string) => string;
  /**
   * value 为空时显示的暗淡占位文本——典型场景：弹模态时 isActive=false，
   * 输入框仍可见但失焦，用 placeholder 透出 "Chat about this" 之类的提示。
   */
  placeholder?: string;
}

const BLINK_MS = 530; // 标准终端 cursor 闪烁周期
const PASTE_CHAR_THRESHOLD = 200;

function looksLikePaste(input: string): boolean {
  // \r 也算：macOS Terminal / iTerm 粘贴多段文本时换行常为 \r 而非 \n，
  // 落进 value 后 \r 会被终端解释为回车（光标回行首）→ 后文覆盖前文，看着像"丢消息"
  return input.includes("\n") || input.includes("\r") || input.length > PASTE_CHAR_THRESHOLD;
}

// bracketed paste 转义：部分终端把粘贴包成 \x1b[200~...\x1b[201~，Ink 不一定剥
function stripBracketedPaste(s: string): string {
  return s.replace(/\x1b\[20[01]~/g, "");
}

// 统一换行：\r\n → \n、裸 \r → \n
// 用途：粘贴 chunk 在注册到 registry 前先规范化，避免 \r 流进 value / 历史 / LLM
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function BgTextInput({
  value,
  onChange,
  onSubmit,
  width,
  backgroundColor,
  color,
  isActive = true,
  onPaste,
  placeholder,
}: BgTextInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const [blinkOn, setBlinkOn] = useState(true);

  useEffect(() => {
    // value 外部改变（commitInput / remount）时把光标移到末尾或夹在合法范围
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  // 光标闪烁：cursor / value 变化时重启 timer 让光标"常亮"过编辑动作；
  // isActive=false（模态弹起）时不闪也不显
  useEffect(() => {
    if (!isActive) return;
    setBlinkOn(true);
    const id = setInterval(() => setBlinkOn((b) => !b), BLINK_MS);
    return () => clearInterval(id);
  }, [isActive, cursor, value]);

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
        // 先剥 bracketed paste 转义，再统一换行符——\r 不处理会让后续渲染 / LLM 都吃坏
        const cleaned = normalizeLineEndings(stripBracketedPaste(input));
        if (!cleaned) return;
        // 检测疑似粘贴：交给调用方决定要不要替换成占位符
        // 避免 \n 直接进 value 让 Text 渲染成多行，把输入框撑到看不见前文
        const insertion =
          onPaste && looksLikePaste(cleaned) ? onPaste(cleaned) : cleaned;
        const next = value.slice(0, cursor) + insertion + value.slice(cursor);
        onChange(next);
        setCursor((c) => c + insertion.length);
      }
    },
    { isActive },
  );

  // 光标渲染：active + blinkOn 时 inverse 高亮；blinkOff 或 inactive 时
  // 保持背景色不显光标，单元格宽度不变（避免布局抖动）
  const showCursor = isActive && blinkOn;

  // 空 value + 有 placeholder → 占位文本模式（暗淡显示，"Chat about this" 风格）
  if (value.length === 0 && placeholder) {
    // 留 1 列给光标位
    const maxW = Math.max(0, width - 1);
    let truncated = placeholder;
    while (stringWidth(truncated) > maxW && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    const usedW = 1 + stringWidth(truncated);
    const padLen = Math.max(0, width - usedW);
    return (
      <Text backgroundColor={backgroundColor} color={color}>
        {showCursor ? (
          <Text backgroundColor="blue" color={color} dimColor>
            {" "}
          </Text>
        ) : (
          <Text backgroundColor={backgroundColor} color={color}>
            {" "}
          </Text>
        )}
        <Text backgroundColor={backgroundColor} dimColor>
          {truncated}
        </Text>
        {" ".repeat(padLen)}
      </Text>
    );
  }

  // 视口计算：保证整行可视宽度 == width，光标永远可见
  // 显示前把 \n / \r 换成 ↵（1 列宽可视符），避免 Ink Text 渲染成真换行 / 回车——
  // 换行会把输入框撑成多行；回车更糟，会让后文覆盖前文看着像"消息丢了"
  const displayValue = value.replace(/[\n\r]/g, "↵");
  const view = computeViewport(displayValue, cursor, width);
  const at = view.atChar;
  const padLen = Math.max(0, width - view.consumedWidth);

  return (
    <Text backgroundColor={backgroundColor} color={color}>
      {view.before}
      {showCursor ? (
        <Text backgroundColor="blue" color={color} dimColor>
          {at}
        </Text>
      ) : (
        <Text backgroundColor={backgroundColor} color={color}>
          {at}
        </Text>
      )}
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

export function stringWidth(s: string): number {
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
