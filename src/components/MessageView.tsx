/**
 * 消息展示组件。区分 user / assistant / tool 三类。
 *
 * Assistant 文本走 marked + marked-terminal，把 markdown 渲染成 ANSI 字符串后交给 Ink Text。
 * 流式中（app.tsx 的 streamingText）保持纯文本，turn 结束后由 history 重渲染替换。
 */

import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { marked } from "marked";
// @ts-expect-error marked-terminal 7.x 无内置 .d.ts；运行时正常
import { markedTerminal } from "marked-terminal";
import type { Message, ContentPart, ToolMessage } from "../types/index.js";
import type { TodoItem } from "../tools/builtin/todo.js";
import { stringWidth } from "./BgTextInput.js";

// chalk 在 module load 时可能基于 stdout 探测把 level 锁成 0（非 TTY、CI 等场景），
// 这会让 markedTerminal 的 chalk.bold/italic 全部返回纯文本，**项目背景** 之类原样吐出。
// Ink 渲染到的目标是 TTY，强制至少 256 色，让 ANSI 码进得了 Text 节点。
if (chalk.level === 0) chalk.level = 3;

// 全局注册一次。markedTerminal() 接受样式参数（heading / blockquote / code 等），先用默认值。
marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

function renderMarkdown(text: string): string {
  try {
    let out = marked.parse(text) as string;
    out = out.replace(/\n+$/, ""); // 末尾换行去掉，免得 Ink Box 多一行空白

    // 修 marked-terminal 在 list item 等场景里把 **bold** / *italic* 当文本吐出来
    // 自己用正则补一刀（在 reset 处理之前做，否则 \x1b[0m 会把 \x1b[1m 切断）
    out = out.replace(/\*\*([^\n*]+?)\*\*/g, (_, body) => `\x1b[1m${body}\x1b[22m`);
    out = out.replace(/(?<![*\\\x1b])\*([^\n*]+?)\*(?!\*)/g, (_, body) => `\x1b[3m${body}\x1b[23m`);

    // marked-terminal 在每个 block 前后塞 \x1b[0m 全 reset——这会把外层的
    // chalk.bgHex（用户消息条带）一并清掉，渲染出"字体处没背景"的断带。
    // 整体剥掉，让样式 close 各自的 \x1b[22m / \x1b[23m / \x1b[39m 收尾即可。
    out = out.replace(/\x1b\[0m/g, "");

    return out;
  } catch {
    // 流到一半的 ```code 等会让 parse 抛错，退化到纯文本
    return text;
  }
}

export function MessageView({
  message,
  resultsByCallId,
}: {
  message: Message;
  /** 上层（app）按 toolUseId 索引的工具结果映射；AssistantMessage 据此把 result 内联到 call 下方。 */
  resultsByCallId?: Map<string, ToolMessage>;
}) {
  switch (message.role) {
    case "user":
      return <UserMessage content={typeof message.content === "string" ? message.content : flattenText(message.content)} />;
    case "assistant":
      return <AssistantMessage content={message.content} resultsByCallId={resultsByCallId} />;
    case "tool":
      // TodoWrite 的清单已在 tool_use 调用处渲染，结果行多余 → 不重复显示
      if (message.toolName === "TodoWrite") return null;
      // 兜底：当结果消息没有匹配的 tool_use（理论上不会发生）独立成一行
      return (
        <ToolResultTree result={message} standalone />
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

/**
 * 用户消息：和输入框同款灰底条带（对齐 Claude Code）。
 * 多行内容每行都填满 bg，首行带 "› " 前缀，后续行用 3 空格缩进保持对齐。
 */
const USER_BG = "#262626";

function UserMessage({ content }: { content: string }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const bandWidth = Math.max(1, termWidth - 1);
  const PREFIX = " › ";
  const PREFIX_W = 3;

  // 先整体过 markdown，再按行切；不能先切行再过——会打断列表 / 代码块 / 表格等多行结构
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  const lines = rendered.split("\n");
  const bg = chalk.bgHex(USER_BG);
  const prefixStyle = chalk.gray.bold;
  // 上下空白行：纯 bg，无文字。让消息条不至于紧贴顶/底文字行
  const padRow = bg(" ".repeat(bandWidth));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{padRow}</Text>
      {lines.map((line, i) => {
        // marked-terminal 的输出含 ANSI 转义；填充宽度要按可见字符算，否则 padLen 偏大
        const visible = stringWidth(stripAnsi(line));
        const padLen = Math.max(0, bandWidth - PREFIX_W - visible);
        const prefix = i === 0 ? PREFIX : "   ";
        // 整行（prefix + content + padding）用 chalk.bgHex 包一层 ANSI bg。
        // 内嵌的 chalk.bold / fg-color 等 ANSI 只 reset fg / attr（\x1b[22m / \x1b[39m），
        // 不会 reset bg，所以灰底贯穿整行，不会有"字体处没背景"的断带。
        const fullLine = bg(prefixStyle(prefix) + line + " ".repeat(padLen));
        return <Text key={i}>{fullLine}</Text>;
      })}
      <Text>{padRow}</Text>
    </Box>
  );
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function AssistantMessage({
  content,
  resultsByCallId,
}: {
  content: ContentPart[];
  resultsByCallId?: Map<string, ToolMessage>;
}) {
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
          // 把匹配的工具结果一起渲染：⏺ Tool(args)  +  └ result
          const result = resultsByCallId?.get(part.id);
          return <ToolCallBlock key={i} name={part.name} args={part.args} result={result} />;
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

/**
 * 单个工具的"调用 + 结果"块（仿 Claude Code 的 ●Tool(...) + └ result 树形展示）。
 * 结果 region 缩进 2 空格，首行用 └ 树枝角标，颜色按状态。
 */
function ToolCallBlock({
  name,
  args,
  result,
}: {
  name: string;
  args: unknown;
  result?: ToolMessage;
}) {
  return (
    <Box flexDirection="column">
      <ToolCallLine name={name} args={args} />
      {result && <ToolResultTree result={result} />}
    </Box>
  );
}

const MAX_RESULT_LINES = 5;

/**
 * 工具结果的树形展示：
 *   - 有 summary → 一行 summary（带 "+N lines" 暗示更多内容）
 *   - 无 summary 且 content 短 → 全展开（每行一条）
 *   - 无 summary 且 content 长 → 头 MAX_RESULT_LINES 行 + "(+M more lines)"
 *
 * standalone 标志：用于兜底（独立成块）的情况——通常不会触发。
 */
function ToolResultTree({ result, standalone = false }: { result: ToolMessage; standalone?: boolean }) {
  const isError = result.isError ?? false;
  const effective: "success" | "error" | "warn" = result.kind ?? (isError ? "error" : "success");
  const dotColor =
    effective === "error" ? "red" : effective === "warn" ? "yellowBright" : "green";

  // bash 等工具会把 stdout/stderr 包在 <stdout>...</stdout> 里给 LLM 区分通道；
  // UI 里把这种独立行的标签剥掉，让用户直接看到 stdout 内容
  const cleaned = stripWrapperTags(result.content);
  const rawLines = cleaned.split("\n");
  // 去尾部空行（XML 标签剥离后常剩一行空）
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  // 去头部空行
  while (rawLines.length > 0 && rawLines[0].trim() === "") rawLines.shift();

  let displayLines: string[];
  let omitted = 0;

  if (result.summary) {
    const extra = rawLines.length > 1 ? ` (+${rawLines.length - 1} lines)` : "";
    displayLines = [result.summary + extra];
  } else if (rawLines.length === 0) {
    displayLines = ["(no output)"];
  } else if (rawLines.length <= MAX_RESULT_LINES) {
    displayLines = rawLines;
  } else {
    displayLines = rawLines.slice(0, MAX_RESULT_LINES);
    omitted = rawLines.length - MAX_RESULT_LINES;
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={standalone ? 1 : 0}>
      {displayLines.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text color={i === 0 ? dotColor : undefined}>{i === 0 ? "└ " : "  "}</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">{line || " "}</Text>
          </Box>
        </Box>
      ))}
      {omitted > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>{`(+${omitted} more lines)`}</Text>
        </Box>
      )}
      {result.diff && <DiffBlock diff={result.diff} />}
    </Box>
  );
}

/** bash 工具内容里独立成行的 <stdout>/<stderr>/<timeout>/<exit_code> 包装标签，UI 不展示。 */
function stripWrapperTags(content: string): string {
  return content
    .split("\n")
    .filter((l) => !/^<\/?(stdout|stderr|timeout|exit_code)>\s*$/.test(l.trim()))
    .join("\n");
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
