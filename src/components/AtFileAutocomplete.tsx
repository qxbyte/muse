/**
 * @ 引用自动补全 overlay。
 *
 * 触发条件:input 在光标位置含有 `@xxx` 段(`@` 后到下一个空白前)。
 * 进入空白后 overlay 关闭。
 *
 * 显示:
 *   - 目录:  `›  dirname/`         紫色(后续可展开)
 *   - 文件:  `+  filename`         默认色
 *   - focused 行整条变紫色 + bold
 *   - 超过 maxVisible 行窗口截取,顶部 / 底部箭头提示
 *
 * 仿 Claude Code 截图:文件 `+ name`,目录 `+ dirname/`。
 */

import React from "react";
import { Box, Text } from "ink";
import type { AtCandidate } from "../preprocess/input/at-source.js";
import { FOCUS_COLOR } from "../ui/theme.js";

export interface AtFileAutocompleteProps {
  matches: AtCandidate[];
  index: number;
  maxVisible?: number;
}

const DEFAULT_MAX = 10;

export function AtFileAutocomplete({ matches, index, maxVisible = DEFAULT_MAX }: AtFileAutocompleteProps) {
  if (matches.length === 0) return null;

  // 窗口:保证 focused 始终可见
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), matches.length - maxVisible));
  const end = Math.min(matches.length, start + maxVisible);
  const visible = matches.slice(start, end);

  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((cand, i) => {
        const realIndex = start + i;
        return <Row key={cand.rel} cand={cand} focused={realIndex === index} />;
      })}
      <Box marginLeft={2}>
        <Text dimColor>
          {`↑↓ select · Tab/Enter accept · Esc cancel${
            matches.length > visible.length ? `  (${matches.length - visible.length} more)` : ""
          }`}
        </Text>
      </Box>
    </Box>
  );
}

function Row({ cand, focused }: { cand: AtCandidate; focused: boolean }) {
  // 显示文本:dir 加 `/` 后缀
  const display = cand.isDir ? `${cand.rel}/` : cand.rel;
  return (
    <Box flexDirection="row">
      <Text color={focused ? FOCUS_COLOR : undefined} bold={focused}>
        {"+ "}{display}
      </Text>
    </Box>
  );
}
