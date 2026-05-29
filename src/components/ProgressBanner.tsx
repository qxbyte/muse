/**
 * 通用进度横幅：cyan 标签 + 经过秒数 + 进度条 + 旋转 tip。
 *
 * 由 SlashActions.showProgress/hideProgress 控制；目前 /compact 是首个使用者。
 *
 * 视觉对齐 Claude Code 的 /compact 体验：
 *   ✦ <Title>... (Ns)
 *     ▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  24%
 *     └ Tip: <rotating>
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

export interface ProgressState {
  title: string;
  tips: string[];
  /** 0-100；ProgressBanner 自行 clamp 与 floor。 */
  getPercent: () => number;
  startTime: number;
}

const BAR_WIDTH = 42;
const TICK_MS = 400;
const TIP_ROTATE_SEC = 5;

export function ProgressBanner({ state }: { state: ProgressState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - state.startTime) / 1000));
  const percent = Math.max(0, Math.min(99, Math.floor(state.getPercent())));
  const filled = Math.floor((percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "▰".repeat(filled) + "▱".repeat(empty);
  const tip = state.tips.length
    ? state.tips[Math.floor(elapsedSec / TIP_ROTATE_SEC) % state.tips.length]
    : "";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan" bold>✦ </Text>
        <Text color="cyan">{state.title}...</Text>
        <Text dimColor>{` (${elapsedSec}s)`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="cyan">{bar}</Text>
        <Text dimColor>{` ${percent}%`}</Text>
      </Box>
      {tip && (
        <Box marginLeft={2}>
          <Text dimColor>{`└ Tip: ${tip}`}</Text>
        </Box>
      )}
    </Box>
  );
}
