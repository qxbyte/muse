/**
 * 消息展示组件。区分 user / assistant / tool 三类。
 *
 * Assistant 文本走 marked + marked-terminal，把 markdown 渲染成 ANSI 字符串后交给 Ink Text。
 * 流式中（app.tsx 的 streamingText）保持纯文本，turn 结束后由 history 重渲染替换。
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { parsePatch } from "diff";
import { highlight, supportsLanguage } from "cli-highlight";
import type { Message, ContentPart, ToolMessage, ToolUsePart } from "../types/index.js";
import type { TodoItem } from "../tools/builtin/todo.js";
import { stringWidth } from "./BgTextInput.js";
import { renderMarkdown } from "../preprocess/render/index.js";
import { FOCUS_COLOR, ACTIVE_TODO_COLOR } from "../ui/theme.js";
import { Shimmer } from "./Shimmer.js";

export function MessageView({
  message,
  resultsByCallId,
  latestTodoWritePartId,
  lastStartedToolId,
}: {
  message: Message;
  /** 上层（app）按 toolUseId 索引的工具结果映射；AssistantMessage 据此把 result 内联到 call 下方。 */
  resultsByCallId?: Map<string, ToolMessage>;
  /** 全局最新一个 TodoWrite tool_use 的 part id。AssistantMessage 用它做 part 级去重——
   *  非最新的 TodoWrite part 不渲染,避免多个 → Todos 块刷屏(当 LLM 把 TodoWrite 跟其他
   *  tool_use 放在同一条 message 里时,message 级去重逻辑无法覆盖,需要 part 级补)。 */
  latestTodoWritePartId?: string;
  /** 最近一次 onToolCallStart 的 tool_use id;BatchedToolBlock 据此 hold 上一个 active row。 */
  lastStartedToolId?: string | null;
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          content={message.content}
          resultsByCallId={resultsByCallId}
          latestTodoWritePartId={latestTodoWritePartId}
          lastStartedToolId={lastStartedToolId}
        />
      );
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

/** 取 ContentPart[] 中所有 text part 拼成一段(给 UserMessage 主体渲染用)。 */
function userTextOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** 取 ContentPart[] 中的 file/image attachments(给 UserMessage 子项渲染用)。 */
interface UserAttachmentRow {
  kind: "file" | "image";
  label: string;
}
function userAttachmentsOf(content: string | ContentPart[]): UserAttachmentRow[] {
  if (typeof content === "string") return [];
  const out: UserAttachmentRow[] = [];
  for (const p of content) {
    if (p.type === "file") out.push({ kind: "file", label: p.path });
    else if (p.type === "image") out.push({ kind: "image", label: p.path ?? `<image ${p.mediaType}>` });
  }
  return out;
}

/**
 * 行首圆点风格统一 ⏺，颜色按消息类型区分（对齐 Claude Code）：
 *   user        → cyan（输入指示符 "> " 保留，不混入圆点风格）
 *   assistant   → cyan          ⏺  普通对话
 *   tool_use    → FOCUS_COLOR   ⏺  工具调用(淡紫,与选择器焦点色统一)
 *   tool result → 树枝 └ 统一 dim,状态信息由上方 tool_use ⏺ 承担
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

function UserMessage({ message }: { message: { content: string | ContentPart[] } }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const bandWidth = Math.max(1, termWidth - 1);
  const PREFIX = " › ";
  const PREFIX_W = 3;

  const text = userTextOf(message.content);
  const attachments = userAttachmentsOf(message.content);

  // 先整体过 markdown,再按行切;不能先切行再过——会打断列表 / 代码块 / 表格等多行结构
  const rendered = useMemo(() => renderMarkdown(text), [text]);
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
      {/* 附件子项:仿 Claude Code 用 `└ ` 树枝标识每个 file / image part */}
      {attachments.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {attachments.map((att, i) => (
            <Box key={i} flexDirection="row">
              <Text dimColor>{"└ "}</Text>
              <Text dimColor>{att.label}</Text>
            </Box>
          ))}
        </Box>
      )}
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
  latestTodoWritePartId,
  lastStartedToolId,
}: {
  content: ContentPart[];
  resultsByCallId?: Map<string, ToolMessage>;
  latestTodoWritePartId?: string;
  lastStartedToolId?: string | null;
}) {
  // message 内 part 级聚合:连续 tool_use(非 TodoWrite) → BatchedToolBlock
  // 解决"LLM 单条 message 含 text + 多个 tool_use"散开渲染的问题:
  //   旧: ● Let me check  /  ● Read(a)  └..  /  ● Read(b)  └..  /  ● Read(c)  └..
  //   新: ● Let me check  /  ● Reading 3 files…  └ Read(a)..  └ Read(b)..  └ Read(c)..
  type RenderItem =
    | { kind: "text"; text: string; key: string }
    | { kind: "todoWrite"; todos: TodoItem[]; listTitle?: string; key: string }
    | { kind: "askUserQuestion"; result?: ToolMessage; key: string }
    | { kind: "batch"; uses: BatchedToolUse[]; key: string };
  const items: RenderItem[] = [];
  let batch: BatchedToolUse[] = [];
  let batchStart = 0;
  const flush = (curIdx: number) => {
    if (batch.length === 0) return;
    items.push({ kind: "batch", uses: batch, key: `b-${batchStart}-${curIdx}` });
    batch = [];
  };
  content.forEach((part, i) => {
    if (part.type === "text") {
      flush(i);
      items.push({ kind: "text", text: part.text, key: `t-${i}` });
    } else if (part.type === "tool_use") {
      if (part.name === "TodoWrite") {
        // TodoWrite 不再在历史区渲染,完全交给底部 sticky TodoList(对齐 Claude Code)。
        // latestTodoWritePartId 字段保留兼容签名,本路径不再消费。
        return;
      } else if (part.name === "AskUserQuestion") {
        // AskUserQuestion 单独走特殊渲染(对齐 Claude Code 的 "User answered Claude's questions" 样式),
        // 不进 batch
        flush(i);
        items.push({ kind: "askUserQuestion", result: resultsByCallId?.get(part.id), key: `q-${i}` });
      } else if (BATCHABLE_TOOLS.has(part.name)) {
        // 纯读工具(Read/Glob/Grep/MemoryRead)进 batch 聚合
        if (batch.length === 0) batchStart = i;
        batch.push({ part, result: resultsByCallId?.get(part.id) });
      } else {
        // 有副作用 / 关键产物的工具(Edit/Write/Bash/WebFetch/MemoryWrite 等)单独显示。
        // 复用 length===1 → ToolCallBlock 的现有 fallback 路径:
        //   header (Tool name + 参数核心) + result + diff(若有)
        flush(i);
        items.push({
          kind: "batch",
          uses: [{ part, result: resultsByCallId?.get(part.id) }],
          key: `single-${i}`,
        });
      }
    }
  });
  flush(content.length);

  return (
    <Box flexDirection="column" marginTop={1}>
      {items.map((item) => {
        if (item.kind === "text") return <AssistantTextPart key={item.key} text={item.text} />;
        if (item.kind === "todoWrite") return <TodoList key={item.key} todos={item.todos} listTitle={item.listTitle} />;
        if (item.kind === "askUserQuestion") return <AskUserQuestionResult key={item.key} result={item.result} />;
        // batch:length === 1 回退原 ToolCallBlock(避免无意义的 header)
        if (item.uses.length === 1) {
          const u = item.uses[0];
          return <ToolCallBlock key={item.key} name={u.part.name} args={u.part.args} result={u.result} />;
        }
        return <BatchedToolBlock key={item.key} uses={item.uses} lastStartedToolId={lastStartedToolId} />;
      })}
    </Box>
  );
}

function AssistantTextPart({ text }: { text: string }) {
  // 不再 collapse-long 折叠:muse 没有 TUI 展开键(Claude Code 有 Ctrl+R,muse 没接),
  // 折叠 = 丢内容。终端 scrollback 足够展示长输出。
  // collapseLong helper 留着供 ResultPipeline 折叠工具结果(那里有 summary 可恢复),
  // 但 assistant 文本直接渲染全文。
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
  // 单工具与 batch 子项共用 innerArg 抽参数核心,header 这里加 Tool name() 包装:
  //   ● Bash(ls -la ~/Git)        ← 不再是 Bash(command="ls -la ~/Git")
  //   ● Read(src/app.tsx)
  //   ● Grep(useState)
  const inner = innerArg(name, args);
  return (
    <Box flexDirection="row">
      <Text color={FOCUS_COLOR}>{DOT} </Text>
      <Text color={FOCUS_COLOR} bold>{name}</Text>
      <Box flexGrow={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">({inner})</Text>
      </Box>
    </Box>
  );
}

export function extractTodos(args: unknown): TodoItem[] {
  if (typeof args !== "object" || args === null) return [];
  const todos = (args as { todos?: unknown }).todos;
  return Array.isArray(todos) ? (todos as TodoItem[]) : [];
}

/** TodoWrite args.listTitle 提取(可选):LLM 给整批 todo 起的标题。 */
export function extractListTitle(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const t = (args as { listTitle?: unknown }).listTitle;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

/** 首条 todo 的 content 截断作为兜底标题(B 方案);省略号 + 最大 40 字。 */
function fallbackTitleFromTodos(todos: TodoItem[]): string {
  const first = todos[0]?.content?.trim();
  if (!first) return "Todos";
  return first.length > 40 ? first.slice(0, 40) + "…" : first;
}

// 仿 Claude Code 的 todos:
// - in_progress 时顶层升级为 active 状态行(Shimmer 扫光 activeForm + 计时)
// - 否则顶层用 LLM 起的 listTitle(A 方案);LLM 没给 → 首条 content 截断兜底(B 方案)
// - 完成态用绿色 ✓(不再 strikethrough,对齐 Claude Code 风格)
export function TodoList({ todos, listTitle }: { todos: TodoItem[]; listTitle?: string }) {
  const inProgress = todos.find((t) => t.status === "in_progress");
  // 用 content 作为身份键(activeForm 可能省略,content 是稳定的)
  const inProgressKey = inProgress?.content ?? null;
  // 该 in_progress 项首次出现的时刻;切到别的 todo 时重置
  const startRef = React.useRef<{ key: string; at: number } | null>(null);
  if (inProgressKey) {
    if (!startRef.current || startRef.current.key !== inProgressKey) {
      startRef.current = { key: inProgressKey, at: Date.now() };
    }
  } else {
    startRef.current = null;
  }
  // 500ms tick 让 (Xs) 计时刷新
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!inProgressKey) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [inProgressKey]);

  // 静态 header 标题:LLM listTitle 优先,否则首条 content 截断,最后 fallback "Todos"
  const staticTitle = listTitle ?? fallbackTitleFromTodos(todos);

  return (
    <Box flexDirection="column" marginTop={1}>
      {inProgress && startRef.current ? (
        <TodoActiveHeader todo={inProgress} elapsedSec={Math.max(0, Math.floor((now - startRef.current.at) / 1000))} />
      ) : (
        <Box flexDirection="row">
          <Text color={FOCUS_COLOR}>{"→ "}</Text>
          <Text color={FOCUS_COLOR} bold>{staticTitle}</Text>
        </Box>
      )}
      {todos.map((todo, i) => (
        <TodoRow key={i} todo={todo} />
      ))}
    </Box>
  );
}

/** 顶层 active header:`● <activeForm>… (Xs)`,activeForm 文字走 Shimmer 扫光。 */
function TodoActiveHeader({ todo, elapsedSec }: { todo: TodoItem; elapsedSec: number }) {
  const label = todo.activeForm ?? todo.content;
  return (
    <Box flexDirection="row">
      <Text color={FOCUS_COLOR}>{DOT} </Text>
      <Shimmer text={label} />
      <Text dimColor>{`… (${elapsedSec}s)`}</Text>
    </Box>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const label = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
  switch (todo.status) {
    case "completed":
      // 完成态:绿色 ✓ + 普通文字(无 strikethrough,对齐 Claude Code)
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text color="green">{"✓ "}</Text>
          <Text>{label}</Text>
        </Box>
      );
    case "in_progress":
      // 进行中:实心方框 ■ + 橙色 ACTIVE_TODO_COLOR bold,对齐 Claude Code todos 风格
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text color={ACTIVE_TODO_COLOR} bold>{"■ "}</Text>
          <Text color={ACTIVE_TODO_COLOR} bold>{label}</Text>
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
 * AskUserQuestion 工具结果的特殊渲染(对齐 Claude Code 的 "User answered" 样式):
 *   ● User answered:
 *     └ · <Question>  → <Answer>
 *         Notes: <user notes>
 * content 来自 ask-user-question.ts execute() 的 Q/A/Notes 文本拼装,这里反向解析。
 */
function AskUserQuestionResult({ result }: { result?: ToolMessage }) {
  if (!result) {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={FOCUS_COLOR}>{DOT} </Text>
        <Text color={FOCUS_COLOR} bold>Waiting for user's answers…</Text>
      </Box>
    );
  }
  const content = result.content ?? "";
  // 取消 / 失败两种特殊态
  if (content.startsWith("User cancelled")) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={FOCUS_COLOR}>{DOT} </Text>
          <Text color={FOCUS_COLOR} bold>User answered:</Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{"└ "}</Text>
          <Text dimColor>(cancelled)</Text>
        </Box>
      </Box>
    );
  }
  if (result.isError) {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={FOCUS_COLOR}>{DOT} </Text>
        <Text color="red">{content || "AskUserQuestion failed"}</Text>
      </Box>
    );
  }
  // 解析 "Q: ... / A: ... / Notes: ..." 块,块之间用 \n\n 分隔
  const blocks = content.split("\n\n");
  const qas: Array<{ q: string; a: string; notes: string }> = [];
  for (const b of blocks) {
    let q = "", a = "", notes = "";
    for (const line of b.split("\n")) {
      if (line.startsWith("Q: ")) q = line.slice(3);
      else if (line.startsWith("A: ")) a = line.slice(3);
      else if (line.startsWith("Notes: ")) notes = line.slice(7);
    }
    if (q) qas.push({ q, a, notes });
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={FOCUS_COLOR}>{DOT} </Text>
        <Text color={FOCUS_COLOR} bold>User answered:</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {qas.map((qa, i) => (
          <Box key={i} flexDirection="column">
            <Box flexDirection="row">
              <Text dimColor>{"└ · "}</Text>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate-end" dimColor>
                  {qa.q}{"  → "}{qa.a}
                </Text>
              </Box>
            </Box>
            {qa.notes && (
              <Box flexDirection="row" marginLeft={4}>
                <Text dimColor wrap="truncate-end">Notes: {qa.notes}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * 单个工具的"调用 + 结果"块（仿 Claude Code 的 ●Tool(...) + └ result 树形展示）。
 * 结果 region 缩进 2 空格，首行用 └ 树枝角标，颜色按状态。
 *
 * Edit/Write 且 result 含 diff 时,header 之下额外加一行 `└ Added N lines, removed M lines`
 * (从 unified diff 字符串数 +/- 行得出),对齐 Claude Code 风格。
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
  const diffStats = useMemo(
    () => (result?.diff ? countDiffStats(result.diff) : null),
    [result?.diff],
  );
  // 从 Edit/Write args 提 file_path 透传给 DiffBlock,用于 syntax highlight 语言推断
  const filePath =
    typeof args === "object" && args !== null
      ? (args as { file_path?: unknown }).file_path
      : undefined;
  const filePathStr = typeof filePath === "string" ? filePath : undefined;
  return (
    <Box flexDirection="column">
      <ToolCallLine name={name} args={args} />
      {diffStats && (
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{"└ "}</Text>
          <Text dimColor>{formatDiffStats(diffStats)}</Text>
        </Box>
      )}
      {result && <ToolResultTree result={result} suppressContent={!!diffStats} filePath={filePathStr} />}
    </Box>
  );
}

/** 数 unified diff 字符串里的 + / - 行(跳过 hunk header `+++` / `---`)。 */
function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function formatDiffStats(s: { added: number; removed: number }): string {
  const parts: string[] = [];
  if (s.added > 0) parts.push(`Added ${s.added} line${s.added === 1 ? "" : "s"}`);
  if (s.removed > 0) parts.push(`removed ${s.removed} line${s.removed === 1 ? "" : "s"}`);
  if (parts.length === 0) return "No changes";
  return parts.join(", ");
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
function ToolResultTree({
  result,
  standalone = false,
  suppressContent = false,
  filePath,
}: {
  result: ToolMessage;
  standalone?: boolean;
  /** Edit/Write 等已经在上层用 `Added N, removed M` 表达了 content 摘要时,跳过这里再渲染一遍 content。
   *  diff 仍然由 DiffBlock 单独渲染。 */
  suppressContent?: boolean;
  /** Edit/Write 的 file_path,透给 DiffBlock 推断 syntax language。 */
  filePath?: string;
}) {
  // bash 等工具会把 stdout/stderr 包在 <stdout>...</stdout> 里给 LLM 区分通道；
  // UI 里把这种独立行的标签剥掉,让用户直接看到 stdout 内容
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
      {!suppressContent &&
        displayLines.map((line, i) => (
          <Box key={i} flexDirection="row">
            {/* └ 统一灰色:状态信息已由上方 ● 的 dotColor 传达,树枝不再叠色,避免视觉杂乱 */}
            <Text dimColor>{i === 0 ? "└ " : "  "}</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{line || " "}</Text>
            </Box>
          </Box>
        ))}
      {!suppressContent && omitted > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>{`(+${omitted} more lines)`}</Text>
        </Box>
      )}
      {result.diff && <DiffBlock diff={result.diff} filePath={filePath} />}
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

/**
 * Diff 渲染:对齐 Claude Code 风格 — 绝对行号 + 整行 bg 高亮(延伸到 EOL)。
 *
 * 数据流:工具(edit/write)生成的 unified diff 字符串 → jsdiff::parsePatch
 *   → hunks 数组(每个 hunk 有 oldStart/newStart + lines[`+/-/space` 前缀])
 *   → 按 hunks 渲染:行号列(右对齐) + `+/-/space` 列 + 内容
 *
 * **bg 延伸到 EOL** 用 ANSI `\x1b[K`(Erase in Line)+ 当前 bg 色:VT100 标准,
 * 终端自动用当前 bg 把行末空白填满,**不需要**算 termWidth 做 padEnd。这避免了
 * 之前 padEnd 算宽度边界跟 Ink Box 实际可用宽度不一致导致的 wrap → 行间空白。
 *
 * 颜色用 ANSI 标准 8 色(bgGreen / bgRed),终端主题决定具体色调
 * (Solarized / Dracula / 默认 各自映射不同绿/红)。
 */
// 用 truecolor RGB(\x1b[48;2;R;G;Bm)做暗绿/暗红,对齐 GitHub / VSCode 暗主题
// diff 风格,不依赖终端主题映射(避免 \x1b[42m 在不同主题下出现刺眼亮绿)。
// 配色参考 GitHub dark + 略提亮(确保中文也能读清)。
const ANSI_BG_ADD = "\x1b[48;2;28;56;33m";    // #1c3821 暗叶绿
const ANSI_BG_REMOVE = "\x1b[48;2;80;30;30m"; // #501e1e 暗酒红
const ANSI_FG = "\x1b[38;2;220;220;220m";     // #dcdcdc 浅灰白(bg 上默认文字)
const ANSI_EL = "\x1b[K";                     // Erase in Line:用当前 bg 把行末填到 EOL
const ANSI_RESET = "\x1b[0m";
const ANSI_FG_RESET = "\x1b[39m";             // 只 reset fg(保留 bg)

/** 文件扩展名 → highlight.js 语言名映射。未列出的返 undefined,DiffLine 跳过 highlight。 */
function inferLanguage(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    php: "php",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    markdown: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    xml: "xml",
    html: "xml",
    css: "css",
    scss: "scss",
    sql: "sql",
    vue: "html",
    svelte: "html",
  };
  const lang = map[ext];
  if (!lang) return undefined;
  // cli-highlight 装载语言要靠 highlight.js;有的语言可能未注册
  try {
    return supportsLanguage(lang) ? lang : undefined;
  } catch {
    return undefined;
  }
}

/** 对单行做 syntax highlight;language 推断失败或 highlight 抛错都退回原文。
 *  关键:把 cli-highlight 输出里的 `\x1b[39m`(fg reset 到终端默认)替换成
 *  我们设定的 ANSI_FG(#dcdcdc),保持外层 fg 不被中断 → bg 上的文字色一致。 */
function highlightLine(text: string, lang?: string): string {
  if (!lang || !text) return text;
  try {
    const out = highlight(text, { language: lang, ignoreIllegals: true });
    // syntax token 内部 reset 用 \x1b[39m → 替回我们的 #dcdcdc,避免恢复终端默认 fg
    return out.replace(/\x1b\[39m/g, ANSI_FG);
  } catch {
    return text;
  }
}

function DiffBlock({ diff, filePath }: { diff: string; filePath?: string }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const hunks = useMemo(() => {
    try {
      const patches = parsePatch(diff);
      return patches[0]?.hunks ?? [];
    } catch {
      return [];
    }
  }, [diff]);

  const lang = useMemo(() => inferLanguage(filePath), [filePath]);

  if (hunks.length === 0) return null;

  const maxLineNum = Math.max(
    ...hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)),
  );
  const lineNumWidth = String(maxLineNum).length;
  // contentWidth = 终端宽 - 左 margin(2) - 行号列(lineNumWidth) - prefix(空格 + mark + 空格 = 3)
  // -1 留 safety,避免边界情况触发 wrap
  const contentWidth = Math.max(10, termWidth - 2 - lineNumWidth - 3 - 1);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {hunks.map((hunk, hi) => (
        <HunkRows
          key={hi}
          oldStart={hunk.oldStart}
          newStart={hunk.newStart}
          lines={hunk.lines}
          lineNumWidth={lineNumWidth}
          contentWidth={contentWidth}
          lang={lang}
        />
      ))}
    </Box>
  );
}

function HunkRows({
  oldStart,
  newStart,
  lines,
  lineNumWidth,
  contentWidth,
  lang,
}: {
  oldStart: number;
  newStart: number;
  lines: string[];
  lineNumWidth: number;
  contentWidth: number;
  lang?: string;
}) {
  let oldCur = oldStart;
  let newCur = newStart;
  const rendered: Array<{ kind: "add" | "remove" | "context"; lineNum: number; text: string }> = [];
  for (const raw of lines) {
    if (raw.startsWith("\\")) continue;
    const ch = raw[0] ?? " ";
    const text = raw.slice(1);
    if (ch === "+") {
      rendered.push({ kind: "add", lineNum: newCur, text });
      newCur++;
    } else if (ch === "-") {
      rendered.push({ kind: "remove", lineNum: oldCur, text });
      oldCur++;
    } else {
      rendered.push({ kind: "context", lineNum: newCur, text });
      oldCur++;
      newCur++;
    }
  }
  return (
    <>
      {rendered.map((r, i) => (
        <DiffLine
          key={i}
          kind={r.kind}
          lineNum={r.lineNum}
          text={r.text}
          lineNumWidth={lineNumWidth}
          contentWidth={contentWidth}
          lang={lang}
        />
      ))}
    </>
  );
}

function DiffLine({
  kind,
  lineNum,
  text,
  lineNumWidth,
  contentWidth,
  lang,
}: {
  kind: "add" | "remove" | "context";
  lineNum: number;
  text: string;
  lineNumWidth: number;
  contentWidth: number;
  lang?: string;
}) {
  const numStr = String(lineNum).padStart(lineNumWidth, " ");
  const mark = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
  // 先做 syntax highlight 再 padEnd:padEnd 用 visible width(stringWidth,忽略 ANSI)
  // 确保整行 bg 延伸到 contentWidth + prefix,所有 +/- 行宽度一致,不随内容长度抖动。
  const highlighted = lang ? highlightLine(text, lang) : text;
  const visible = stringWidth(stripAnsi(highlighted));
  // 截断或 padding:长内容截断到 contentWidth;短内容用空格补到 contentWidth(空格也吃 bg 色)
  const padded =
    visible > contentWidth ? truncateVisible(highlighted, contentWidth) : highlighted + " ".repeat(contentWidth - visible);
  const inner = ` ${mark} ${padded}`;
  let styled: string;
  if (kind === "add") {
    styled = `${ANSI_BG_ADD}${ANSI_FG}${inner}${ANSI_RESET}`;
  } else if (kind === "remove") {
    styled = `${ANSI_BG_REMOVE}${ANSI_FG}${inner}${ANSI_RESET}`;
  } else {
    // context 行不染 bg;高亮后 dim 一层让它柔和
    styled = chalk.dim(inner);
  }
  return (
    <Box flexDirection="row">
      <Text dimColor>{numStr}</Text>
      <Text>{styled}</Text>
    </Box>
  );
}

/** 把带 ANSI 的字符串按 visible width 截断到 maxWidth;粗略实现:
 *  按 visible 字符逐个累加,不破坏 ANSI 序列。截断后补一个 reset(若有未闭合 ANSI 上下文)。 */
function truncateVisible(text: string, maxWidth: number): string {
  let visibleCount = 0;
  let i = 0;
  let out = "";
  while (i < text.length && visibleCount < maxWidth) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b && text[i + 1] === "[") {
      // ANSI escape:`ESC [ ... letter`,整段照搬,不算 visible
      const end = text.indexOf("m", i + 2);
      if (end < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
    } else {
      const c = text[i];
      const w = stringWidth(c);
      if (visibleCount + w > maxWidth) break;
      out += c;
      visibleCount += w;
      i++;
    }
  }
  return out;
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

/**
 * 可 batch 聚合的工具白名单 — 仿 Claude Code:探索/查询类工具进 batch。
 *
 * 完成态不再"完全隐藏子项",改为常驻显示前 MAX_DONE_ROWS 行 + `(+N more)` 折叠,
 * 让用户能扫一眼跑过什么命令;长 stdout 详情可走 scrollback 回看。
 *
 * **不**进 batch:Edit / Write(diff 必看) / TodoWrite(独立 sticky) /
 *   AskUserQuestion(独立 Q&A 渲染) / MemoryWrite(写动作)
 */
export const BATCHABLE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "MemoryRead",
  "Bash",
  "WebFetch",
]);

// ============== Batched tool rendering ==============
// muse 的 agent ReAct 是串行 tool loop:每跑 1 个工具就单独成一条 assistant message。
// 散开显示在多次连续 tool 调用时观感差(垂直占用大、节奏被切碎),改用 Claude Code 风格的
// "batch 聚合"——把连续的只含 tool_use 的 assistant message 合并为一个虚拟块,
// header 用复数形式,子项一行一条。

export interface BatchedToolUse {
  part: ToolUsePart;
  result?: ToolMessage;
}

/** 按工具名生成 batch header:
 *  - 单一类型 → 复数模板,如 "Running 4 shell commands…" (展开子项)
 *  - 混合类型 → 动名词摘要句,如 "Searched for 2 patterns, read 1 file, ran 1 shell command" (不展子项) */
function batchHeader(uses: BatchedToolUse[]): string {
  const counts = new Map<string, number>();
  for (const u of uses) counts.set(u.part.name, (counts.get(u.part.name) ?? 0) + 1);
  if (counts.size === 1) {
    const [name, n] = [...counts.entries()][0];
    return labelForN(name, n);
  }
  // 混合:按工具名排序拼动名词短语,首字母大写,. 结尾的语感更克制 → 不加句号
  const phrases = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, n]) => actionPhrase(name, n));
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** 单一类型场景:工具名 + 复数 label;有省略号表示"正在/已经处理多个" 的现在进行感。 */
function labelForN(toolName: string, n: number): string {
  const s = n > 1 ? "s" : "";
  switch (toolName) {
    case "Bash": return `Running ${n} shell command${s}…`;
    case "Read": return `Reading ${n} file${s}…`;
    case "Grep": return `Searched ${n} pattern${s}`;
    case "Glob": return `Searched ${n} glob${s}`;
    case "WebFetch": return `Fetched ${n} URL${s}`;
    case "Edit": return `Editing ${n} file${s}…`;
    case "Write": return `Writing ${n} file${s}…`;
    case "AskUserQuestion": return `Asking ${n} question${s}`;
    case "MemoryRead": return `Reading ${n} memor${n > 1 ? "ies" : "y"}…`;
    case "MemoryWrite": return `Writing ${n} memor${n > 1 ? "ies" : "y"}…`;
    default: return `${toolName} ×${n}`;
  }
}

/** 混合 batch 场景:工具名 + 动名词短语 (lowercase,被 join 拼成英文句子)。 */
function actionPhrase(toolName: string, n: number): string {
  const s = n > 1 ? "s" : "";
  switch (toolName) {
    case "Bash": return `ran ${n} shell command${s}`;
    case "Read": return `read ${n} file${s}`;
    case "Grep": return `searched for ${n} pattern${s}`;
    case "Glob": return `searched ${n} glob${s}`;
    case "WebFetch": return `fetched ${n} URL${s}`;
    case "Edit": return `edited ${n} file${s}`;
    case "Write": return `wrote ${n} file${s}`;
    case "AskUserQuestion": return `asked ${n} question${s}`;
    case "MemoryRead": return `read ${n} memor${n > 1 ? "ies" : "y"}`;
    case "MemoryWrite": return `wrote ${n} memor${n > 1 ? "ies" : "y"}`;
    default: return `used ${n} ${toolName}${s}`;
  }
}

/** active row 切换最小停留时间(ms):让快命令(本地 ls/cat 几十 ms)的 active row 也能被看见。
 *  Claude Code 同样手法 — 渲染层加 sticky delay,实际 tool 执行速度不变。 */
const ACTIVE_ROW_STICKY_MS = 500;

/** 全展开子项时最多渲染几行,余下用 `(+N more)` 折叠,避免 50+ 项的 batch 把屏幕占满。 */
const MAX_EXPANDED_ROWS = 5;
/** 完成态(allDone)默认显示前 N 行 + (+M more) 折叠 — 不再完全隐藏,对齐 Claude Code:
 *  既视觉紧凑,又能扫一眼看到 agent 跑过什么(尤其 Bash/WebFetch 这种命令)。 */
const MAX_DONE_ROWS = 3;

export function BatchedToolBlock({
  uses,
  lastStartedToolId,
}: {
  uses: BatchedToolUse[];
  /** 最近一次 onToolCallStart 的 tool_use id;用于 "hold 上一个直到下一个真的开始" 语义。
   *  未提供时回退到 firstPending(下一个没 result 的)。 */
  lastStartedToolId?: string | null;
}) {
  // Claude Code 风格 transient 渲染:
  // - 全部完成 → 显示前 MAX_DONE_ROWS 行 + `(+N more)` 折叠提示(对齐 Claude Code:
  //   既视觉紧凑,又能扫一眼看到 agent 跑过什么命令/读了什么文件)
  // - 执行中 → 用灰色 `└` 显示 active row;**hold 上一个直到下一个真的开始**:
  //   target 优先匹配 lastStartedToolId(最近一次 onToolCallStart 的 id),避免
  //   firstPending 立刻跳到 LLM 还在思考 / 等权限的下一个 tool。未拿到 id 时
  //   (初始 / Static 包的历史 batch)回退 firstPending。
  // - **abort 中断**(Esc)→ 整批展开 MAX_EXPANDED_ROWS 行 + 折叠,让用户看清楚
  //   muse 当时干到哪一步被打断,避免"消失感"
  const allDone = uses.every((u) => u.result);
  let targetIdx = -1;
  if (!allDone) {
    if (lastStartedToolId) {
      targetIdx = uses.findIndex((u) => u.part.id === lastStartedToolId);
    }
    if (targetIdx < 0) {
      // 没匹配上 → 回退到 firstPending 给个初始显示
      targetIdx = uses.findIndex((u) => !u.result);
    }
  }
  // sticky displayIdx:targetIdx 切换后延迟 ACTIVE_ROW_STICKY_MS 再生效,
  // 保证每个 active row 至少可见这么长时间(连续快切时旧 timeout 被 clear,直接跳终值)。
  const [displayIdx, setDisplayIdx] = useState(targetIdx);
  useEffect(() => {
    if (targetIdx === displayIdx) return;
    const t = setTimeout(() => setDisplayIdx(targetIdx), ACTIVE_ROW_STICKY_MS);
    return () => clearTimeout(t);
  }, [targetIdx, displayIdx]);
  const activeIdx = displayIdx >= 0 && displayIdx < uses.length ? displayIdx : -1;
  const wasInterrupted = uses.some(
    (u) => u.result?.content?.includes("Interrupted by user (Esc)"),
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={FOCUS_COLOR}>{DOT} </Text>
        <Text color={FOCUS_COLOR} bold>{batchHeader(uses)}</Text>
      </Box>
      {wasInterrupted ? (
        <Box flexDirection="column" marginLeft={2}>
          {uses.slice(0, MAX_EXPANDED_ROWS).map((u, i) => (
            <BatchedToolRow key={i} use={u} />
          ))}
          {uses.length > MAX_EXPANDED_ROWS && (
            <Box flexDirection="row">
              <Text dimColor>{"  "}</Text>
              <Text dimColor>{`(+${uses.length - MAX_EXPANDED_ROWS} more)`}</Text>
            </Box>
          )}
        </Box>
      ) : activeIdx >= 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          <BatchedToolRow use={uses[activeIdx]} />
        </Box>
      ) : (
        // 完成态:显示前 MAX_DONE_ROWS 行 + `(+N more)` 折叠(对齐 Claude Code)
        <Box flexDirection="column" marginLeft={2}>
          {uses.slice(0, MAX_DONE_ROWS).map((u, i) => (
            <BatchedToolRow key={i} use={u} />
          ))}
          {uses.length > MAX_DONE_ROWS && (
            <Box flexDirection="row">
              <Text dimColor>{"  "}</Text>
              <Text dimColor>{`(+${uses.length - MAX_DONE_ROWS} more)`}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function BatchedToolRow({ use }: { use: BatchedToolUse }) {
  // 按工具类型展示参数核心,不再用 Tool(args=...) 代码风格,对齐 Claude Code:
  //   Read/Edit/Write    → 文件路径
  //   Bash               → $ <command>
  //   Grep/Glob          → pattern
  //   WebFetch           → URL
  //   其他               → fallback 到 Tool(args)
  const summary = formatToolUseSummary(use.part);
  return (
    <Box flexDirection="row">
      <Text dimColor>{"└ "}</Text>
      <Box flexGrow={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">{summary}</Text>
      </Box>
    </Box>
  );
}

/** 工具参数核心(去 key=value 包装),单工具 header 与 batch 子项共用。 */
function innerArg(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "Bash":
      return str("command");
    case "Read":
    case "Edit":
    case "Write":
      return str("file_path");
    case "Grep":
      return str("pattern");
    case "Glob":
      return str("pattern");
    case "WebFetch":
      return str("url");
    case "MemoryRead":
    case "MemoryWrite":
      return str("path");
    case "AskUserQuestion": {
      const qs = a.questions;
      const n = Array.isArray(qs) ? qs.length : 0;
      return `${n} question${n === 1 ? "" : "s"}`;
    }
    default:
      return formatArgs(args);
  }
}

/** Batch 子项的"无 header 独立行"展示:Bash 加 `$` 前缀提示 shell 命令,其他直接用核心参数。 */
function formatToolUseSummary(part: ToolUsePart): string {
  const inner = innerArg(part.name, part.args);
  return part.name === "Bash" ? `$ ${inner}` : inner;
}
