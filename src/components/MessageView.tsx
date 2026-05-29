/**
 * 消息展示组件。区分 user / assistant / tool 三类。
 *
 * Assistant 文本走 marked + marked-terminal，把 markdown 渲染成 ANSI 字符串后交给 Ink Text。
 * 流式中（app.tsx 的 streamingText）保持纯文本，turn 结束后由 history 重渲染替换。
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
// @ts-expect-error marked-terminal 7.x 无内置 .d.ts；运行时正常
import { markedTerminal } from "marked-terminal";
import type { Message, ContentPart } from "../types/index.js";
import type { TodoItem } from "../tools/builtin/todo.js";

// 全局注册一次。markedTerminal() 接受样式参数（heading / blockquote / code 等），先用默认值。
marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

function renderMarkdown(text: string): string {
  try {
    const out = marked.parse(text) as string;
    // marked 末尾通常带额外换行，去掉以免在 Ink Box 里多一行空白
    return out.replace(/\n+$/, "");
  } catch {
    // 流到一半的 ```code 等会让 parse 抛错，退化到纯文本
    return text;
  }
}

export function MessageView({ message }: { message: Message }) {
  switch (message.role) {
    case "user":
      return <UserMessage content={typeof message.content === "string" ? message.content : flattenText(message.content)} />;
    case "assistant":
      return <AssistantMessage content={message.content} />;
    case "tool":
      // TodoWrite 的清单已在 tool_use 调用处渲染，结果行多余 → 不重复显示
      if (message.toolName === "TodoWrite") return null;
      return (
        <ToolResultLine
          isError={message.isError ?? false}
          content={message.content}
          diff={message.diff}
          summary={message.summary}
          kind={message.kind}
        />
      );
    case "system":
      return null;
  }
}

function flattenText(parts: ContentPart[]): string {
  return parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n");
}

/**
 * 行首圆点风格统一 ⏺，颜色按消息类型区分（对齐 Claude Code）：
 *   user        → cyan（输入指示符 "> " 保留，不混入圆点风格）
 *   assistant   → cyan        ⏺  普通对话
 *   tool_use    → yellow      ⏺  工具调用（一行参数 + 截断）
 *   tool result → green       ⏺  执行成功
 *                 red         ⏺  错误
 *                 yellowBright⏺  warn（redirect/降级/部分成功）
 *
 * Batch 分组：同一 assistant turn 内的多个 tool_use 直接堆叠（无 marginTop），
 * 不同 turn 间靠 AssistantMessage 的 marginTop={1} 区隔。
 */
export const DOT = "⏺";

function UserMessage({ content }: { content: string }) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color="cyan" bold>{"> "}</Text>
      <Text>{content}</Text>
    </Box>
  );
}

function AssistantMessage({ content }: { content: ContentPart[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {content.map((part, i) => {
        if (part.type === "text") {
          return <AssistantTextPart key={i} text={part.text} />;
        }
        if (part.type === "tool_use") {
          if (part.name === "TodoWrite") {
            return <TodoList key={i} todos={extractTodos(part.args)} />;
          }
          return <ToolCallLine key={i} name={part.name} args={part.args} />;
        }
        return null;
      })}
    </Box>
  );
}

function AssistantTextPart({ text }: { text: string }) {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return (
    <Box flexDirection="row">
      <Text color="cyan">{DOT} </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text>{rendered}</Text>
      </Box>
    </Box>
  );
}

function ToolCallLine({ name, args }: { name: string; args: unknown }) {
  const argSummary = formatArgs(args);
  // wrap="truncate-end" 让 args 在终端宽度内一行截断；外层 row 默认占满终端宽度。
  return (
    <Box flexDirection="row">
      <Text color="yellow">{DOT} </Text>
      <Text color="yellow" bold>{name}</Text>
      <Box flexGrow={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">({argSummary})</Text>
      </Box>
    </Box>
  );
}

function extractTodos(args: unknown): TodoItem[] {
  if (typeof args !== "object" || args === null) return [];
  const todos = (args as { todos?: unknown }).todos;
  return Array.isArray(todos) ? (todos as TodoItem[]) : [];
}

// 仿 Claude Code 的 checkbox 清单：完成态打钩 + 删除线，进行中高亮，待办置灰。
function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="yellow">{"→ "}</Text>
        <Text color="yellow" bold>Todos</Text>
      </Box>
      {todos.map((todo, i) => (
        <TodoRow key={i} todo={todo} />
      ))}
    </Box>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const label = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
  switch (todo.status) {
    case "completed":
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text color="green">{"☒ "}</Text>
          <Text dimColor strikethrough>{label}</Text>
        </Box>
      );
    case "in_progress":
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text color="cyan" bold>{"☐ "}</Text>
          <Text color="cyan" bold>{label}</Text>
        </Box>
      );
    default:
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{"☐ "}</Text>
          <Text dimColor>{label}</Text>
        </Box>
      );
  }
}

function ToolResultLine({
  isError,
  content,
  diff,
  summary,
  kind,
}: {
  isError: boolean;
  content: string;
  diff?: string;
  summary?: string;
  kind?: "success" | "error" | "warn";
}) {
  // 摘要来源优先级：tool 提供的 summary → content 第一行（最多 200 字符）
  const fallback = (() => {
    const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;
    return preview.split("\n")[0];
  })();
  const headLine = summary ?? fallback;

  // 多行内容追加 "(+N lines)" 提示，告知用户实际内容更长
  const totalLines = content.split("\n").length;
  const extra = totalLines > 1 ? ` (+${totalLines - 1} lines)` : "";

  // kind 显式优先；否则 isError → "error"；否则 "success"
  const effective: "success" | "error" | "warn" = kind ?? (isError ? "error" : "success");
  const dotColor =
    effective === "error" ? "red" : effective === "warn" ? "yellowBright" : "green";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box flexDirection="row">
        <Text color={dotColor}>{DOT} </Text>
        <Box flexGrow={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {headLine}
            {extra}
          </Text>
        </Box>
      </Box>
      {diff && <DiffBlock diff={diff} />}
    </Box>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  // jsdiff createPatch 头四行：Index / === / --- / +++；省略，只渲染 hunks
  const lines = diff.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const rendered = start >= 0 ? lines.slice(start) : lines;
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {rendered.map((line, i) => {
        let color: string | undefined;
        let dim = false;
        if (line.startsWith("+")) color = "green";
        else if (line.startsWith("-")) color = "red";
        else if (line.startsWith("@@")) {
          color = "cyan";
          dim = true;
        } else {
          dim = true;
        }
        return (
          <Text key={i} color={color} dimColor={dim}>
            {line || " "}
          </Text>
        );
      })}
    </Box>
  );
}

function formatArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  for (const [k, v] of entries) {
    if (typeof v === "string") {
      const truncated = v.length > 40 ? v.slice(0, 40) + "..." : v;
      parts.push(`${k}="${truncated}"`);
    } else {
      parts.push(`${k}=${JSON.stringify(v).slice(0, 40)}`);
    }
  }
  return parts.join(", ");
}
