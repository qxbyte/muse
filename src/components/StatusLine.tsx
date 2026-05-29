/**
 * 处理中的状态行（流式 / 工具执行期间常驻底部）。
 *
 * 两行设计：
 *   ●  Working… ✨闪烁    (12s · ↑ 1.2k tokens · thought for 4s)
 *      ↳ Read(src/foo.ts)            ← 仅 runningTool != null 时出现
 *
 * 主线（Working）始终在跑，扫光动画提示 "活着"。工具行作为子线路按需呈现。
 * 不接收 status 字段——调用方根据 status !== "idle" 决定是否挂载本组件。
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Shimmer } from "./Shimmer.js";

const TICK_MS = 400;

export interface StatusLineProps {
  /** 本轮开始时间（user_submit 触发时 Date.now()）。 */
  startTime: number;
  /** 首次 text-delta 时间（"thought for" 用）；null 表示尚未流出任何 text。 */
  firstTextTime: number | null;
  /** 本轮已累计的 input tokens（usage 事件累加，>0 才显示）。 */
  inputTokens: number;
  /** 工具运行中时的工具名，null 表示不在跑工具。 */
  runningTool: string | null;
  /** UI 语言：影响标签文案。 */
  lang: "en" | "zh-CN";
}

export function StatusLine({ startTime, firstTextTime, inputTokens, runningTool, lang }: StatusLineProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - startTime) / 1000));
  const mainLabel = lang === "zh-CN" ? "工作中" : "Working";

  const parts: string[] = [formatDuration(elapsedSec)];
  if (inputTokens > 0) {
    parts.push(`↑ ${formatTokens(inputTokens)} tokens`);
  }
  if (firstTextTime !== null) {
    const thinkSec = Math.max(0, Math.floor((firstTextTime - startTime) / 1000));
    parts.push(
      lang === "zh-CN" ? `思考 ${formatDuration(thinkSec)}` : `thought for ${formatDuration(thinkSec)}`,
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="gray">● </Text>
        <Shimmer text={mainLabel} />
        <Text dimColor>{`  (${parts.join(" · ")})`}</Text>
      </Box>
      {runningTool && (
        <Box flexDirection="row" marginLeft={2} marginTop={0}>
          <Text dimColor>{"↳ "}</Text>
          <Text color="cyan">{runningTool}</Text>
        </Box>
      )}
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}
