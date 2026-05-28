/**
 * Session 选择器：列出当前 cwd 下的历史会话，键盘选中加载。
 *
 * 由 /resume 命令通过 ctx.actions.pickSession(...) 拉起。
 * 行布局对齐 /resume display 文本版（id8 · time · [N msgs] · preview），
 * 视觉差异：紫色 `›` 箭头 + 边框 + 选中态。
 */

import React from "react";
import { Box, Text } from "ink";
import { Selector } from "./Selector.js";
import type { SessionSummary } from "../session/jsonl.js";

export interface SessionPickerRequest {
  items: SessionSummary[];
  currentId?: string;
  resolve: (picked: SessionSummary | null) => void;
}

export function SessionSelector({ request }: { request: SessionPickerRequest }) {
  const { items, currentId, resolve } = request;
  const initialIndex = Math.max(
    0,
    items.findIndex((s) => s.id === currentId),
  );

  return (
    <Selector
      items={items}
      initialIndex={initialIndex}
      maxVisible={12}
      title="Resume session"
      hint="↑↓ navigate · Enter load · Esc cancel"
      onSubmit={(s) => resolve(s)}
      onCancel={() => resolve(null)}
      renderRow={(s) => <SessionRow session={s} active={s.id === currentId} />}
    />
  );
}

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const id8 = session.id.slice(0, 8);
  const time = formatTime(session.createdAt);
  const count = `[${String(session.messageCount).padStart(2)} msgs]`;
  const preview = session.preview ?? "(empty)";

  return (
    <Box flexDirection="row">
      <Text color={active ? "green" : undefined}>{active ? "● " : "  "}</Text>
      <Text>{id8}</Text>
      <Text dimColor>{"  "}{time}</Text>
      <Text dimColor>{"  "}{count}</Text>
      <Text>{"  "}{preview}</Text>
    </Box>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
