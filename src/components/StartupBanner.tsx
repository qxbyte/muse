/**
 * 启动 banner：圆角灰框风格（对齐业界 CLI 横幅常见做法）。
 *
 * 布局：
 *   ╭──────────────────────────────────────────────╮
 *   │ >_ Muse (v0.1.3)                            │
 *   │                                             │
 *   │ model:     <id>            /model to change │
 *   │ directory: <cwd>                            │
 *   ╰─────────────────────────────────────────────╯
 *
 * 终端窄于 50 列退化为单行。alignSelf=flex-start 让框 shrink-to-content，
 * 不被 column 父容器的 stretch 默认值撑满整行。
 */

import React from "react";
import { Box, Text } from "ink";

const COLORS = {
  border: "gray",
  prompt: "white",
  app: "white",
  version: "gray",
  label: "white",
  value: "#5EE3B5",
  hint: "gray",
} as const;

const LABEL_MODEL = "model:";
const LABEL_DIR = "directory:";
const LABEL_WIDTH = Math.max(LABEL_MODEL.length, LABEL_DIR.length); // 10
const LABEL_TO_VALUE_GAP = 1;
const VALUE_TO_HINT_GAP = 4;

export interface StartupBannerProps {
  version: string;
  model: string;
  cwd: string;
}

function padLabel(label: string): string {
  return label + " ".repeat(LABEL_WIDTH - label.length + LABEL_TO_VALUE_GAP);
}

export function StartupBanner({ version, model, cwd }: StartupBannerProps) {
  return (
    <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor={COLORS.border} paddingX={1}>
      <Box flexDirection="row">
        <Text color={COLORS.prompt} bold>{">_ "}</Text>
        <Text color={COLORS.app} bold>Muse</Text>
        <Text color={COLORS.version}>{` (v${version})`}</Text>
      </Box>
      <Box height={1} />
      <Box flexDirection="row">
        <Text color={COLORS.label}>{padLabel(LABEL_MODEL)}</Text>
        <Text color={COLORS.value}>{model}</Text>
        <Text color={COLORS.hint}>{" ".repeat(VALUE_TO_HINT_GAP)}/model to change</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={COLORS.label}>{padLabel(LABEL_DIR)}</Text>
        <Text color={COLORS.value}>{cwd}</Text>
      </Box>
    </Box>
  );
}

/** 窄终端（< 50 列）单行兜底。 */
export function SingleLineBanner({ version, model }: Omit<StartupBannerProps, "cwd">) {
  return (
    <Text>
      <Text color={COLORS.app} bold>Muse </Text>
      <Text color={COLORS.version}>v{version}</Text>
      <Text color={COLORS.app}>{" · "}</Text>
      <Text color={COLORS.value}>{model}</Text>
    </Text>
  );
}

export function pickBanner(width: number, props: StartupBannerProps): React.ReactElement {
  if (width >= 50) return <StartupBanner {...props} />;
  return <SingleLineBanner version={props.version} model={props.model} />;
}
