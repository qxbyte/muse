/**
 * 自带背景色的轻量输入组件，替换 ink-text-input。
 *
 * Why：Ink 的 Box 不支持 backgroundColor 属性（只有 Text 支持），
 * 而 ink-text-input 输出的 Text 不暴露 bg 注入口。要实现"整行高亮背景"
 * 的输入条（对齐 Claude Code 风格），最干净的方式是自己渲染。
 *
 * 实现：单个 Text 节点，padEnd 到 termWidth，cursor 用 inverse 字符表示。
 * useInput 接管字符 / 方向键 / 删除 / Enter / Backspace。
 *
 * 不支持：多行、IME 复合输入、宽字符（CJK）精确光标位置——v0.1 范围。
 */

import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";

export interface BgTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** 主体内容宽度（"› " 这种前缀外），用于 padEnd 让 bg 填满整行。 */
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

  // value 外部改变（commitInput）时把光标移到末尾——这是 ink-text-input remount 也做的事
  useEffect(() => {
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
      // home/end
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      // 不消费 Ctrl+C / Shift+Tab / ↑↓ / Tab / Esc——交给 App 顶层 useInput
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

  // 渲染：左侧 value[..cursor]，光标位置一字符 inverse 高亮，右侧 value[cursor+1..]，
  // padEnd 到 width 让背景延伸到行尾
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  const consumed = before.length + 1 + after.length; // before + cursor cell + after
  const pad = Math.max(0, width - consumed);

  return (
    <Text backgroundColor={backgroundColor} color={color}>
      {before}
      <Text backgroundColor={backgroundColor} color={color} inverse>
        {at}
      </Text>
      {after}
      {" ".repeat(pad)}
    </Text>
  );
}
