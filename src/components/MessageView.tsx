/**
 * 消息展示组件。区分 user / assistant / tool 三类。
 *
 * Assistant 文本走 marked + marked-terminal，把 markdown 渲染成 ANSI 字符串后交给 Ink Text。
 * 流式中（app.tsx 的 streamingText）保持纯文本，turn 结束后由 history 重渲染替换。
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import type { Message, ContentPart, ToolMessage, ToolUsePart } from "../types/index.js";
import type { TodoItem } from "../tools/builtin/todo.js";
import { stringWidth } from "./BgTextInput.js";
import { renderMarkdown } from "../preprocess/render/index.js";
import { FOCUS_COLOR, ACTIVE_TODO_COLOR } from "../ui/theme.js";

export function MessageView({
  message,
  resultsByCallId,
  latestTodoWritePartId,
}: {
  message: Message;
  /** 上层（app）按 toolUseId 索引的工具结果映射；AssistantMessage 据此把 result 内联到 call 下方。 */
  resultsByCallId?: Map<string, ToolMessage>;
  /** 全局最新一个 TodoWrite tool_use 的 part id。AssistantMessage 用它做 part 级去重——
   *  非最新的 TodoWrite part 不渲染,避免多个 → Todos 块刷屏(当 LLM 把 TodoWrite 跟其他
   *  tool_use 放在同一条 message 里时,message 级去重逻辑无法覆盖,需要 part 级补)。 */
  latestTodoWritePartId?: string;
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
}: {
  content: ContentPart[];
  resultsByCallId?: Map<string, ToolMessage>;
  latestTodoWritePartId?: string;
}) {
  // message 内 part 级聚合:连续 tool_use(非 TodoWrite) → BatchedToolBlock
  // 解决"LLM 单条 message 含 text + 多个 tool_use"散开渲染的问题:
  //   旧: ● Let me check  /  ● Read(a)  └..  /  ● Read(b)  └..  /  ● Read(c)  └..
  //   新: ● Let me check  /  ● Reading 3 files…  └ Read(a)..  └ Read(b)..  └ Read(c)..
  type RenderItem =
    | { kind: "text"; text: string; key: string }
    | { kind: "todoWrite"; todos: TodoItem[]; key: string }
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
        // part 级去重:历史里多个 TodoWrite,只渲染最新那个;非最新的整体跳过
        if (latestTodoWritePartId !== undefined && part.id !== latestTodoWritePartId) return;
        flush(i);
        items.push({ kind: "todoWrite", todos: extractTodos(part.args), key: `td-${i}` });
      } else if (part.name === "AskUserQuestion") {
        // AskUserQuestion 单独走特殊渲染(对齐 Claude Code 的 "User answered Claude's questions" 样式),
        // 不进 batch
        flush(i);
        items.push({ kind: "askUserQuestion", result: resultsByCallId?.get(part.id), key: `q-${i}` });
      } else {
        if (batch.length === 0) batchStart = i;
        batch.push({ part, result: resultsByCallId?.get(part.id) });
      }
    }
  });
  flush(content.length);

  return (
    <Box flexDirection="column" marginTop={1}>
      {items.map((item) => {
        if (item.kind === "text") return <AssistantTextPart key={item.key} text={item.text} />;
        if (item.kind === "todoWrite") return <TodoList key={item.key} todos={item.todos} />;
        if (item.kind === "askUserQuestion") return <AskUserQuestionResult key={item.key} result={item.result} />;
        // batch:length === 1 回退原 ToolCallBlock(避免无意义的 header)
        if (item.uses.length === 1) {
          const u = item.uses[0];
          return <ToolCallBlock key={item.key} name={u.part.name} args={u.part.args} result={u.result} />;
        }
        return <BatchedToolBlock key={item.key} uses={item.uses} />;
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
        <Text color={FOCUS_COLOR}>{"→ "}</Text>
        <Text color={FOCUS_COLOR} bold>Todos</Text>
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
      // 完成态:dim ☒ + dim 删除线;去掉 green,与整列统一灰度,更克制
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{"☒ "}</Text>
          <Text dimColor strikethrough>{label}</Text>
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
      {displayLines.map((line, i) => (
        <Box key={i} flexDirection="row">
          {/* └ 统一灰色:状态信息已由上方 ● 的 dotColor 传达,树枝不再叠色,避免视觉杂乱 */}
          <Text dimColor>{i === 0 ? "└ " : "  "}</Text>
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

export function BatchedToolBlock({ uses }: { uses: BatchedToolUse[] }) {
  // Claude Code 风格 transient 渲染:
  // - 执行中 → 用灰色 `└` 连接符显示当前正在执行的那一条(最近一个没 result 的 use)
  // - 全部完成 → 只剩 header,子项隐藏(批次完成后视觉归零,history 区简洁)
  // - **abort 中断**(Esc)→ 整批展开所有子项,让用户看清楚 muse 当时干到哪一步
  //   被打断,避免"消失感"(只剩干瘪 header 看上去像内容被删了)
  const realActiveIdx = uses.findIndex((u) => !u.result);
  // sticky displayIdx:实际 active 切换后延迟 ACTIVE_ROW_STICKY_MS 再切显示,
  // 保证每个 active row 至少可见这么长时间(连续快切时旧的 setTimeout 被 clear,
  // 直接跳到最终值;首次切换 + 完成隐藏都走同一延迟)。
  const [displayIdx, setDisplayIdx] = useState(realActiveIdx);
  useEffect(() => {
    if (realActiveIdx === displayIdx) return;
    const t = setTimeout(() => setDisplayIdx(realActiveIdx), ACTIVE_ROW_STICKY_MS);
    return () => clearTimeout(t);
  }, [realActiveIdx, displayIdx]);
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
          {uses.map((u, i) => (
            <BatchedToolRow key={i} use={u} />
          ))}
        </Box>
      ) : activeIdx >= 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          <BatchedToolRow use={uses[activeIdx]} />
        </Box>
      ) : null}
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
