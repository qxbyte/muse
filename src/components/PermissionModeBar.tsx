/**
 * 权限模式状态栏。固定在 TUI 输入框下方。
 *
 * 设计：见文档库 permission-modes.md §四 状态栏 UI。
 */

import React from "react";
import { Box, Text } from "ink";
import { MODE_LABEL, MODE_COLOR, type PermissionMode } from "../permission/index.js";

export function PermissionModeBar({ mode, compact }: { mode: PermissionMode; compact?: boolean }) {
  const color = MODE_COLOR[mode];
  const label = MODE_LABEL[mode];
  const isBypass = mode === "bypassPermissions";

  if (compact) {
    const short: Record<PermissionMode, string> = {
      default: "[default]",
      acceptEdits: "[edits]",
      plan: "[plan]",
      bypassPermissions: "[bypass]",
    };
    return (
      <Box flexDirection="row">
        <Text color={color} bold={isBypass}>{short[mode]}</Text>
        <Text dimColor>{" shift+tab"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color={color} bold={isBypass}>{"▸▸ "}{label}</Text>
      <Text dimColor>{" (shift+tab to cycle)"}</Text>
    </Box>
  );
}
