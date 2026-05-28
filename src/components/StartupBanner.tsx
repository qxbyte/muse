/**
 * 启动 banner。
 *
 * Logo: 5x10 紫色实心方块 + 左侧矩形凹口 + 中间两只眼睛（眼睛与凹口都用空格透出终端背景）。
 * 无边框，Claude Code 风格的简洁排版。
 */

import React from "react";
import { Box, Text } from "ink";

// 用 Quadrant Blocks（▖▗▘▝▙▚▛▜▞▟）让每个字符代表 2×2 子像素，比 ▀▄ 再翻一倍分辨率。
// 整体物理宽度只有 ▀▄ 版本的一半，但 `>_` 反而更细致（4 列子像素描绘 V 形 + 横线）。
// 兼容性：macOS/Linux/Windows 主流等宽字体均支持；少数老 SSH 客户端可能渲染异常。
const LOGO_ROWS = [
  "▗▟█▙▖",
  "█▙▜██",
  "█▙█▄▟",
  "▝██▛▘",
] as const;

const COLORS = {
  logo: "#8B5CF6",
  asterisk: "#06B6D4",
  text: "white",
  versionAccent: "#FDE047",
} as const;

const LOGO_WIDTH = 5;
const GAP_WIDTH = 6;

export interface StartupBannerProps {
  version: string;
  model: string;
  cwd: string;
}

function LogoLine({ row }: { row: number }) {
  return <Text color={COLORS.logo}>{LOGO_ROWS[row]}</Text>;
}

function BannerLine({ row, children }: { row: number; children?: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box width={LOGO_WIDTH}>
        <LogoLine row={row} />
      </Box>
      <Box width={GAP_WIDTH} />
      {children ?? null}
    </Box>
  );
}

export function StartupBanner({ version, model, cwd }: StartupBannerProps) {
  return (
    <Box flexDirection="column" paddingY={1}>
      <BannerLine row={0} />
      <BannerLine row={1}>
        <Box flexDirection="row">
          <Text color={COLORS.asterisk}>✻</Text>
          <Text color={COLORS.text}>{" Welcome to Muse "}</Text>
          <Text color={COLORS.versionAccent}>v{version}</Text>
        </Box>
      </BannerLine>
      <BannerLine row={2}>
        <Text color={COLORS.text}>model: {model}</Text>
      </BannerLine>
      <BannerLine row={3}>
        <Text color={COLORS.text}>cwd:   {cwd}</Text>
      </BannerLine>
    </Box>
  );
}

/** 紧凑模式：终端窄于 60 列时，省略 logo，仅文字。 */
export function CompactBanner({ version, model, cwd }: StartupBannerProps) {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box flexDirection="row">
        <Text color={COLORS.asterisk}>✻</Text>
        <Text color={COLORS.text}>{" Welcome to Muse "}</Text>
        <Text color={COLORS.versionAccent}>v{version}</Text>
      </Box>
      <Text color={COLORS.text}>model: {model}</Text>
      <Text color={COLORS.text}>cwd:   {cwd}</Text>
    </Box>
  );
}

/** 单行模式：终端 < 40 列。 */
export function SingleLineBanner({ version, model }: Omit<StartupBannerProps, "cwd">) {
  return (
    <Text>
      <Text color={COLORS.text}>Muse </Text>
      <Text color={COLORS.versionAccent}>v{version}</Text>
      <Text color={COLORS.text}> · {model}</Text>
    </Text>
  );
}

export function pickBanner(width: number, props: StartupBannerProps): React.ReactElement {
  if (width >= 60) return <StartupBanner {...props} />;
  if (width >= 40) return <CompactBanner {...props} />;
  return <SingleLineBanner version={props.version} model={props.model} />;
}
