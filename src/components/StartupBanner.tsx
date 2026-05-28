/**
 * 启动 banner（彩虹 MUSE 字母版，无边框）。
 *
 * 4 个字母各 5×5 像素，间距 2 字符，logo 总宽 26 字符 × 高 5 行。
 * M 红 / U 橙 / S 黄 / E 绿（彩虹渐变）；✻ 青；v 亮黄；正文白。
 * 无边框，简洁排版，对齐右侧三行信息：✻ Welcome / model / cwd。
 */

import React from "react";
import { Box, Text } from "ink";

// 每个字母 5 行 × 5 字符宽的像素图。S 顶/底完整 █████ 避免拐弯吐出。
const LETTERS = {
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  U: ["█   █", "█   █", "█   █", "█   █", " ███ "],
  S: ["█████", "█    ", " ███ ", "    █", "█████"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
} as const;

const COLORS = {
  M: "#EF4444",
  U: "#F97316",
  S: "#EAB308",
  E: "#22C55E",
  asterisk: "#06B6D4",
  text: "white",
  versionAccent: "#FDE047",
} as const;

const LETTER_GAP = 3; // 字母之间的空格（避免视觉粘连）
const LOGO_WIDTH = 5 * 4 + LETTER_GAP * 3; // 29
const GAP_WIDTH = 6; // logo 到右侧文字的间距

export interface StartupBannerProps {
  version: string;
  model: string;
  cwd: string;
}

function LogoLine({ row }: { row: number }) {
  // 用 Box marginLeft 显式控制字母间距：yoga flex 不会"吃"空格，比 Text 拼空格稳。
  return (
    <Box flexDirection="row">
      <Box>
        <Text color={COLORS.M}>{LETTERS.M[row]}</Text>
      </Box>
      <Box marginLeft={LETTER_GAP}>
        <Text color={COLORS.U}>{LETTERS.U[row]}</Text>
      </Box>
      <Box marginLeft={LETTER_GAP}>
        <Text color={COLORS.S}>{LETTERS.S[row]}</Text>
      </Box>
      <Box marginLeft={LETTER_GAP}>
        <Text color={COLORS.E}>{LETTERS.E[row]}</Text>
      </Box>
    </Box>
  );
}

function BannerLine({ row, children }: { row: number; children?: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box minWidth={LOGO_WIDTH}>
        <LogoLine row={row} />
      </Box>
      <Box width={GAP_WIDTH} />
      {children ?? null}
    </Box>
  );
}

export function StartupBanner({ version, model, cwd }: StartupBannerProps) {
  return (
    <Box flexDirection="column" paddingY={0}>
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
      <BannerLine row={4} />
    </Box>
  );
}

/** 紧凑模式：终端窄于 60 列时，省略 logo，仅文字。 */
export function CompactBanner({ version, model, cwd }: StartupBannerProps) {
  return (
    <Box flexDirection="column" paddingY={0}>
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
