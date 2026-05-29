/**
 * 输入框下方的状态尾栏（对齐 Claude Code 风格）。
 *
 * 信息（从左到右）：
 *   @<sid8>            当前 session 短 id（首 8 字符；resume 后亦同）
 *   <model>            当前模型 id
 *   ctx: ████░ NN%     上下文窗口填充率（基于最近一轮 input tokens / maxContextWindow）
 *   <in>/<max>         绝对值，便于核对
 *   ↑<in> ↓<out>       本会话累计 token（自 app 启动后；/resume 不回灌）
 *
 * 配色（对齐 Claude Code 的 footer）：
 *   session id  → cyan bold        （如 Claude Code 的 "Sync code..." 标题色）
 *   model       → magenta          （如 Claude Code 的 "Opus 4.7 (1M context)" 粉品红）
 *   "ctx:"      → 默认白            （label 不 dim，醒目）
 *   填充进度条   → 主题色：<70% green / 70–89% yellow / ≥90% red（"快爆"警告）
 *   百分比 / in/max → dim gray      （次要信息）
 *   "│"        → dim gray          （分隔符弱化）
 *   ↑ 累计 in  → green
 *   ↓ 累计 out → blueBright
 *
 * 宽度策略：
 *   termWidth >= 100   完整版（含累计 token）
 *   60 ≤ width < 100   精简版（去掉 ↑↓ 累计、去掉 in/max）
 *   width < 60         极简版（只剩 sid · model · 进度条 NN%）
 */

import React from "react";
import { Box, Text } from "ink";

const BAR_TOTAL_WIDE = 10;
const BAR_TOTAL_COMPACT = 6;

export interface FooterStatusProps {
  /** 当前 session id（取首 8 字符显示）。 */
  sessionId: string;
  /** 当前模型 id（如 "deepseek-chat"）。 */
  model: string;
  /** 模型上下文窗口大小；0/未知时隐藏 ctx 字段。 */
  contextWindow: number;
  /** 最近一轮 input tokens；约等于本轮 prompt 实际占用的上下文。 */
  lastInputTokens: number;
  /** 本会话累计 input tokens。 */
  sessionInputTokens: number;
  /** 本会话累计 output tokens。 */
  sessionOutputTokens: number;
  /** 终端宽度，用于布局降级。 */
  termWidth: number;
}

export function FooterStatus({
  sessionId,
  model,
  contextWindow,
  lastInputTokens,
  sessionInputTokens,
  sessionOutputTokens,
  termWidth,
}: FooterStatusProps) {
  const sid = sessionId.slice(0, 8);
  const hasCtx = contextWindow > 0;
  const pct = hasCtx ? Math.min(100, Math.round((lastInputTokens / contextWindow) * 100)) : 0;
  const ctxColor: "green" | "yellow" | "red" = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";

  const SEP = <Text dimColor>{" │ "}</Text>;
  const SEP_DOT = <Text dimColor>{" · "}</Text>;

  // 已填部分按阈值上色，未填部分恒 dim gray；0% 时整条灰
  const renderBar = (barW: number): React.ReactNode => {
    const filled = Math.round((pct / 100) * barW);
    const empty = barW - filled;
    return (
      <>
        {filled > 0 && <Text color={ctxColor}>{"█".repeat(filled)}</Text>}
        {empty > 0 && <Text dimColor>{"░".repeat(empty)}</Text>}
      </>
    );
  };

  // <60: 极简
  if (termWidth < 60) {
    return (
      <Box flexDirection="row">
        <Text color="cyan" bold>{sid}</Text>
        {SEP_DOT}
        <Text color="magenta">{model}</Text>
        {hasCtx && (
          <>
            {SEP_DOT}
            {renderBar(BAR_TOTAL_COMPACT)}
            <Text dimColor>{` ${pct}%`}</Text>
          </>
        )}
      </Box>
    );
  }

  // 60–100: 精简（无累计 token、无 in/max 绝对值）
  if (termWidth < 100) {
    return (
      <Box flexDirection="row">
        <Text color="cyan" bold>{`@${sid}`}</Text>
        {SEP}
        <Text color="magenta">{model}</Text>
        {hasCtx && (
          <>
            {SEP}
            <Text>{"ctx: "}</Text>
            {renderBar(BAR_TOTAL_COMPACT)}
            <Text dimColor>{` ${pct}%`}</Text>
          </>
        )}
      </Box>
    );
  }

  // ≥100: 完整
  return (
    <Box flexDirection="row">
      <Text color="cyan" bold>{`@${sid}`}</Text>
      {SEP}
      <Text color="magenta">{model}</Text>
      {hasCtx && (
        <>
          {SEP}
          <Text>{"ctx: "}</Text>
          {renderBar(BAR_TOTAL_WIDE)}
          <Text dimColor>{` ${pct}%`}</Text>
          <Text dimColor>{`  ${formatTokens(lastInputTokens)}/${formatTokens(contextWindow)}`}</Text>
        </>
      )}
      {SEP}
      <Text>{"tok: "}</Text>
      <Text color="green">{`↑${formatTokens(sessionInputTokens)}`}</Text>
      <Text> </Text>
      <Text color="blueBright">{`↓${formatTokens(sessionOutputTokens)}`}</Text>
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}
