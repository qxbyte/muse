/**
 * 处理中的状态行（流式 / 工具执行期间常驻底部）。
 *
 * 样式（对齐 Claude Code）：
 *   ✱ <Verb>… (<elapsed>s · ↑ <tokens> tokens · thought for <Ns>)
 *
 * 字段：
 * - ✱ 红色 star spinner（自动旋转）
 * - <Verb>：runningTool 时显示 "Running <ToolName>"，否则按 elapsedSec / 4 在 verb 池里轮换
 * - elapsed：本轮开始至今的秒数
 * - ↑ tokens：本轮已累计的 input tokens（usage 事件没回灌时省略此字段）
 * - thought for：从本轮开始到首个 text-delta 的时长；首字符流出后即冻结显示
 *
 * 不接收 status 字段——调用方根据 status !== "idle" 决定是否挂载本组件。
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

const VERBS_EN = [
  "Thinking",
  "Pondering",
  "Musing",
  "Brewing",
  "Reasoning",
  "Cogitating",
  "Synthesizing",
  "Composing",
  "Crunching",
  "Distilling",
  "Forging",
  "Weaving",
  "Polishing",
  "Drafting",
  "Sketching",
  "Deliberating",
  "Reflecting",
  "Conjuring",
  "Hatching",
  "Whirring",
  "Computing",
  "Plotting",
  "Spinning",
  "Cooking",
];

const VERBS_ZH = [
  "思考",
  "推敲",
  "酝酿",
  "梳理",
  "雕琢",
  "斟酌",
  "构思",
  "运算",
  "锤炼",
  "盘算",
  "捋思路",
  "整理",
  "琢磨",
  "推演",
  "勾画",
  "捏合",
  "拼装",
  "打磨",
  "编织",
  "翻找",
];

const TICK_MS = 400;
const VERB_ROTATE_SEC = 4;

export interface StatusLineProps {
  /** 本轮开始时间（user_submit 触发时 Date.now()）。 */
  startTime: number;
  /** 首次 text-delta 时间（"thought for" 用）；null 表示尚未流出任何 text。 */
  firstTextTime: number | null;
  /** 本轮已累计的 input tokens（usage 事件累加，>0 才显示）。 */
  inputTokens: number;
  /** 工具运行中时的工具名，null 表示不在跑工具（显示 verb 池内容）。 */
  runningTool: string | null;
  /** UI 语言：影响 verb 池与字段标签。 */
  lang: "en" | "zh-CN";
}

export function StatusLine({ startTime, firstTextTime, inputTokens, runningTool, lang }: StatusLineProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - startTime) / 1000));
  const verbs = lang === "zh-CN" ? VERBS_ZH : VERBS_EN;
  const verbBase = runningTool
    ? lang === "zh-CN"
      ? `运行 ${runningTool}`
      : `Running ${runningTool}`
    : verbs[Math.floor(elapsedSec / VERB_ROTATE_SEC) % verbs.length];

  const parts: string[] = [`${formatDuration(elapsedSec)}`];
  if (inputTokens > 0) {
    parts.push(lang === "zh-CN" ? `↑ ${formatTokens(inputTokens)} tokens` : `↑ ${formatTokens(inputTokens)} tokens`);
  }
  if (firstTextTime !== null) {
    const thinkSec = Math.max(0, Math.floor((firstTextTime - startTime) / 1000));
    parts.push(
      lang === "zh-CN" ? `思考 ${formatDuration(thinkSec)}` : `thought for ${formatDuration(thinkSec)}`,
    );
  }

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color="red">
        <Spinner type="star" />
      </Text>
      <Text color="cyan">{` ${verbBase}…`}</Text>
      <Text dimColor>{` (${parts.join(" · ")})`}</Text>
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
