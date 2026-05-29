/**
 * 字面闪烁动画：一个明亮窗口从左往右扫过文字，到尾巴后有短暂间隔再从头来。
 *
 * 渲染方式：把 text 拆成单字符 <Text>，按到当前 phase 的距离上色——
 *   distance 0  → bright white + bold
 *   distance 1  → white
 *   其他       → dim gray
 * 一个 setInterval 推进 phase。
 *
 * 视觉效果：像扫光带掠过 "Working" 字样，无 spinner 字符。
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAME_MS = 100;
const TRAIL = 4; // 扫完最后一个字符后再走几帧再绕回起点，给眼睛留间隔

export interface ShimmerProps {
  text: string;
  bold?: boolean;
}

export function Shimmer({ text, bold = true }: ShimmerProps) {
  const chars = Array.from(text);
  const cycle = chars.length + TRAIL;

  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setPhase((p) => (p + 1) % cycle);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [cycle]);

  return (
    <Text>
      {chars.map((ch, i) => {
        const d = Math.abs(i - phase);
        if (d === 0) {
          return (
            <Text key={i} color="white" bold={bold}>
              {ch}
            </Text>
          );
        }
        if (d === 1) {
          return (
            <Text key={i} color="white">
              {ch}
            </Text>
          );
        }
        return (
          <Text key={i} color="gray" dimColor>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}
