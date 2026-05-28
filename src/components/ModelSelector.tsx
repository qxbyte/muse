/**
 * 模型选择器：用 Selector 骨架实现，提供 model entry 专用行渲染。
 *
 * 由 /models 命令通过 ctx.actions.pickModel(...) 拉起。
 * 接口（ModelPickerRequest）保持稳定，便于 app.tsx 不动 actions.pickModel 调用方。
 */

import React from "react";
import { Box, Text } from "ink";
import { Selector } from "./Selector.js";
import type { ModelEntry } from "../config/models.js";

export interface ModelPickerRequest {
  items: ModelEntry[];
  currentId?: string;
  resolve: (picked: ModelEntry | null) => void;
}

export function ModelSelector({ request }: { request: ModelPickerRequest }) {
  const { items, currentId, resolve } = request;
  const initialIndex = Math.max(
    0,
    items.findIndex((m) => m.id === currentId),
  );
  const labelWidth = Math.max(...items.map((m) => (m.name ?? m.id).length));

  return (
    <Selector
      items={items}
      initialIndex={initialIndex}
      title="Select model"
      hint="↑↓ navigate · Enter confirm · Esc cancel"
      onSubmit={(m) => resolve(m)}
      onCancel={() => resolve(null)}
      renderRow={(m, _focused) => (
        <ModelRow model={m} active={m.id === currentId} labelWidth={labelWidth} />
      )}
    />
  );
}

function ModelRow({
  model,
  active,
  labelWidth,
}: {
  model: ModelEntry;
  active: boolean;
  labelWidth: number;
}) {
  const dot = active ? "●" : " ";
  const label = (model.name ?? model.id).padEnd(labelWidth);
  const vendor = model.vendor ? `[${model.vendor}]` : "";
  const caps = formatCaps(model);

  return (
    <Box flexDirection="row">
      <Text color={active ? "green" : undefined}>{dot} </Text>
      <Text>{label}</Text>
      <Text dimColor>{"  "}{vendor}</Text>
      {caps && <Text dimColor>{"  "}{caps}</Text>}
    </Box>
  );
}

function formatCaps(m: ModelEntry): string {
  const flags: string[] = [];
  if (m.supportsToolCall === false) flags.push("no-tools");
  if (m.supportsImages) flags.push("vision");
  return flags.length ? flags.join(" · ") : "";
}
