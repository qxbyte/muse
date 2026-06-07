/**
 * 流式 markdown 渲染:实时渲染已闭合段落,未闭合段保留纯文本。
 *
 * 设计:
 *   1. 节流 16ms / 32 字符,降低 setState 频率
 *   2. splitStableUnstable 切 stable + unstable
 *   3. **关键优化**:marked.lexer 把 stable 进一步切成 block tokens(段/代码块/list 等);
 *      每个 block 是独立 React.memo + useMemo 组件,内容不变 → 不重 parse / 不重渲染
 *   4. unstable 直接纯文本(短,parse 没意义)
 *
 * 闪屏根因 + 修法:
 *   - 之前每次 stable 增长都把整段 stable 重 parse + 重 reconcile → 长输出累积时
 *     CPU + Ink 重画整段动态区 → 视觉闪屏
 *   - 现在按 block 切分缓存,只有新闭合 block 触发 parse,旧 block 走 cache
 *   - React.memo 阻止旧 block 的 re-render,Ink 看到 child 没变也会减少 erase
 *
 * 段切分用 marked.lexer 而非简单 \n\n split:
 *   - fence 代码块内空行会被 \n\n 误切;lexer 把 fence 当一个 token,边界正确
 *   - lexer 1-3ms,只在 stable 变化时跑一次,可接受
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import { renderMarkdown } from "../preprocess/render/markdown.js";
import { splitStableUnstable } from "../preprocess/render/stream-markdown.js";

const FLUSH_INTERVAL_MS = 16;
const TOKEN_THRESHOLD = 32;

export interface StreamingMarkdownProps {
  text: string;
}

export function StreamingMarkdown({ text }: StreamingMarkdownProps) {
  // 节流 setState,避免每 delta 都触发 re-render
  const [flushed, setFlushed] = useState(text);
  const lastFlushAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastFlushAtRef.current;
    const delta = text.length - flushed.length;
    if (elapsed >= FLUSH_INTERVAL_MS || delta >= TOKEN_THRESHOLD) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setFlushed(text);
      lastFlushAtRef.current = now;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setFlushed(text);
      lastFlushAtRef.current = Date.now();
    }, FLUSH_INTERVAL_MS - elapsed);
  }, [text, flushed]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // 切 stable + unstable;再用 marked.lexer 把 stable 切成 block tokens
  const { stableBlocks, unstable } = useMemo(() => {
    const { stable, unstable } = splitStableUnstable(flushed);
    if (!stable) return { stableBlocks: [] as string[], unstable };
    let blocks: string[];
    try {
      const tokens = marked.lexer(stable);
      blocks = tokens
        .map((t) => ((t as { raw?: string }).raw ?? "").replace(/\n+$/, ""))
        .filter((s) => s.trim().length > 0);
    } catch {
      // lexer 出错退化到 \n\n 切分(fence 内空行可能误切,可接受)
      blocks = stable.split(/\n{2,}/).filter((s) => s.trim().length > 0);
    }
    return { stableBlocks: blocks, unstable };
  }, [flushed]);

  if (stableBlocks.length === 0 && !unstable) return null;

  return (
    <Box flexDirection="column">
      {stableBlocks.map((block, i) => (
        <StableBlock key={i} text={block} />
      ))}
      {unstable && <Text>{unstable}</Text>}
    </Box>
  );
}

/** 单个已闭合 markdown block:text 不变 → useMemo 命中 + React.memo 阻止 re-render。 */
const StableBlock = React.memo(function StableBlock({ text }: { text: string }) {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return <Text>{rendered}</Text>;
});
