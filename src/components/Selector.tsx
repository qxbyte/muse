/**
 * 通用键盘 selector 骨架：↑↓ 导航 + Enter 确认 + Esc 取消。
 *
 * 行渲染由 renderRow 回调提供；本组件只负责：
 * - 键盘事件
 * - 焦点状态 + 滑动窗口（保证 focused 始终可见）
 * - 紫色 `›` 焦点指针（颜色 #A855F7，对齐用户截图）
 * - 标题 + 提示
 *
 * 当前调用方：ModelSelector / SessionSelector。
 * 第三处再考虑把外层 borderStyle 等做成 prop；暂时硬编码。
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

const POINTER_COLOR = "#A855F7";

export interface SelectorProps<T> {
  items: T[];
  initialIndex?: number;
  title?: string;
  hint?: string;
  maxVisible?: number;
  renderRow: (item: T, focused: boolean) => React.ReactNode;
  onSubmit: (item: T) => void;
  onCancel: () => void;
}

export function Selector<T>({
  items,
  initialIndex = 0,
  title,
  hint,
  maxVisible,
  renderRow,
  onSubmit,
  onCancel,
}: SelectorProps<T>) {
  const safeInitial = Math.max(0, Math.min(initialIndex, items.length - 1));
  const [index, setIndex] = useState(safeInitial);

  useInput((_, key) => {
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (key.return) {
      onSubmit(items[index]);
    } else if (key.escape) {
      onCancel();
    }
  });

  const len = items.length;
  const window = maxVisible && maxVisible < len ? maxVisible : len;
  const start = Math.max(0, Math.min(index - Math.floor(window / 2), len - window));
  const end = Math.min(len, start + window);
  const visible = items.slice(start, end);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="round"
      borderColor="cyan"
    >
      {(title || hint) && (
        <Box marginBottom={1}>
          {title && <Text bold>{title}</Text>}
          {title && hint && <Text dimColor>{"  "}</Text>}
          {hint && <Text dimColor>{hint}</Text>}
        </Box>
      )}
      {visible.map((item, i) => {
        const realIndex = start + i;
        const focused = realIndex === index;
        return (
          <Box key={realIndex} flexDirection="row">
            <Text color={POINTER_COLOR} bold>
              {focused ? "› " : "  "}
            </Text>
            {renderRow(item, focused)}
          </Box>
        );
      })}
      {window < len && (
        <Box marginTop={1}>
          <Text dimColor>
            ({start + 1}-{end} / {len})
          </Text>
        </Box>
      )}
    </Box>
  );
}
