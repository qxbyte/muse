/**
 * Slash 命令自动补全 overlay。
 *
 * 触发条件：input.startsWith("/") && !input.includes(" ")（用户在输入命令名阶段）
 * 进入参数阶段（空格之后）→ overlay 关闭，让用户安静地输入参数
 *
 * 显示：默认色 / + name + dim description
 *       focused 行整条命令名变紫色 + bold（不用 inverse 背景条）
 *       超过 maxVisible 行折叠尾部
 *
 * 渲染由 App 控制，本组件是纯展示。
 */

import React from "react";
import { Box, Text } from "ink";
import type { SlashCommand } from "../slash/index.js";

export interface SlashAutocompleteProps {
  matches: SlashCommand[];
  index: number;
  maxVisible?: number;
}

const DEFAULT_MAX = 10;
const SLASH_COLOR = "#A855F7";

export function SlashAutocomplete({ matches, index, maxVisible = DEFAULT_MAX }: SlashAutocompleteProps) {
  if (matches.length === 0) return null;

  // 窗口：保证 focused 始终可见
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), matches.length - maxVisible));
  const end = Math.min(matches.length, start + maxVisible);
  const visible = matches.slice(start, end);

  const nameWidth = Math.max(...matches.map((c) => c.name.length));

  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((cmd, i) => {
        const realIndex = start + i;
        return (
          <Row key={cmd.name} cmd={cmd} focused={realIndex === index} nameWidth={nameWidth} />
        );
      })}
      {matches.length > visible.length && (
        <Box marginLeft={2}>
          <Text dimColor>
            ↑↓ select · Tab/Enter accept · Esc cancel  ({matches.length - visible.length} more)
          </Text>
        </Box>
      )}
      {matches.length <= visible.length && (
        <Box marginLeft={2}>
          <Text dimColor>↑↓ select · Tab/Enter accept · Esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}

function Row({ cmd, focused, nameWidth }: { cmd: SlashCommand; focused: boolean; nameWidth: number }) {
  const padded = cmd.name.padEnd(nameWidth);
  // focused 整条命令名变紫色 + bold；非 focused 用默认色
  return (
    <Box flexDirection="row">
      <Text color={focused ? SLASH_COLOR : undefined} bold={focused}>
        {"/"}{padded}
      </Text>
      <Text>{"   "}</Text>
      <Text dimColor>{cmd.description}</Text>
    </Box>
  );
}
