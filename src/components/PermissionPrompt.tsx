/**
 * 工具调用的权限确认 prompt（v2 picker）。
 *
 * ↑/↓ 选择 + Enter 确认；快捷键 y/s/n 与 1/2/3 直接落子；Esc 等价于 no。
 *
 * 三选项：
 *   1. Yes                              — 本次允许
 *   2. Yes, allow <Tool> for session    — 后续该 toolName 在 session 内全部 allow
 *   3. No                                — 拒绝
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "../permission/index.js";
import { FOCUS_COLOR } from "../ui/theme.js";

export interface PermissionRequest {
  toolName: string;
  args: unknown;
  summary: string;
  resolve: (decision: PermissionDecision) => void;
}

const OPTIONS: { decision: PermissionDecision; labelKey: "yes" | "session" | "no"; shortcut: string }[] = [
  { decision: "yes", labelKey: "yes", shortcut: "y" },
  { decision: "session_allow", labelKey: "session", shortcut: "s" },
  { decision: "no", labelKey: "no", shortcut: "n" },
];

export function PermissionPrompt({ request }: { request: PermissionRequest }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      request.resolve(OPTIONS[index].decision);
      return;
    }
    if (key.escape) {
      request.resolve("no");
      return;
    }
    const lower = input?.toLowerCase?.();
    for (let i = 0; i < OPTIONS.length; i++) {
      const o = OPTIONS[i];
      if (lower === o.shortcut || input === String(i + 1)) {
        request.resolve(o.decision);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⏵ Approve {request.toolName}?
      </Text>
      <Text dimColor>{request.summary}</Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => {
          const focused = i === index;
          const label = labelFor(o.labelKey, request.toolName);
          return (
            <Text key={o.decision} color={focused ? FOCUS_COLOR : undefined} bold={focused}>
              {focused ? "› " : "  "}
              {i + 1}. {label}{"  "}
              <Text dimColor>({o.shortcut})</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Enter confirm · y/s/n shortcut · Esc=no</Text>
      </Box>
    </Box>
  );
}

function labelFor(key: "yes" | "session" | "no", toolName: string): string {
  switch (key) {
    case "yes":
      return "Yes";
    case "session":
      return `Yes, allow ${toolName} for the rest of this session`;
    case "no":
      return "No";
  }
}
