/**
 * AskUserQuestion UI——完整复刻 Claude Code 的链式选择器。
 *
 * 布局：
 *
 *   ─────────────────────────────────────────────────────────────────
 *   ← □ Header1   □ Header2   □ Header3   ✔ Submit   →
 *
 *   Question text?
 *
 *   1. Option A                       ┌──────────────────────────────┐
 *      description                    │  preview content for the     │
 *   2. Option B                       │  focused option              │
 *      description                    │  (multi-line allowed)        │
 *                                     └──────────────────────────────┘
 *
 *                 Notes: press n to add notes
 *   ─────────────────────────────────────────────────────────────────
 *   Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
 *
 * 状态:
 *   - 每题独立 optionIndex / selected / notes
 *   - notesEditing 切换内联文本编辑器（Enter 保存 / Esc 退出回 picker，不取消整批）
 *
 * 键位:
 *   ↑↓        选项移动
 *   ←→ / Tab  题间切换（含 Submit chip）
 *   Enter     option 上：单选 → 选定 + 跳下一题；多选 → toggle
 *             Submit 上 → 提交
 *   Space     多选 toggle
 *   n         进入 notes 编辑（Enter 保存 / Esc 退出）
 *   Esc       picker 取消
 *
 * Tab chip 标记:
 *   单选未答 □  / 答了 ✔
 *   多选未选 □  / 选了 N 个 [N]
 *   聚焦 chip 走 FOCUS_BG 背景高亮
 *
 * 单题特化:
 *   单题不渲染 tab bar / Submit chip——单选 Enter 直提交；多选 Submit 行放选项末尾
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskQuestion, AskQuestionResponse } from "../tools/builtin/ask-user-question.js";

const POINTER_COLOR = "#A855F7"; // 焦点行指针 + 焦点项 label
const FOCUS_BG = "#5B5598"; // 聚焦 chip 背景（柔和淡紫）
const FOCUS_FG = "white";
const SUBMIT_COLOR = "green";
const NOTES_LABEL_COLOR = "yellow";
const PREVIEW_BORDER = "gray";
const TAB_GAP = 3;
const PREVIEW_MIN_WIDTH = 28;

export interface QuestionPickerRequest {
  questions: AskQuestion[];
  resolve: (responses: AskQuestionResponse[]) => void;
}

interface QState {
  optionIndex: number;
  selected: Set<number>;
  notes: string;
  notesEditing: boolean;
  /** notes 编辑中的草稿——Enter 保存到 notes / Esc 丢弃。 */
  notesDraft: string;
}

export function QuestionPicker({ request }: { request: QuestionPickerRequest }) {
  const { questions } = request;
  const N = questions.length;
  const hasTabs = N > 1;
  const submitTabIndex = N;

  const [tabIndex, setTabIndex] = useState(0);
  const [states, setStates] = useState<QState[]>(() =>
    questions.map(() => ({
      optionIndex: 0,
      selected: new Set<number>(),
      notes: "",
      notesEditing: false,
      notesDraft: "",
    })),
  );

  const currentQ = tabIndex < N ? questions[tabIndex] : null;
  const isMulti = currentQ?.multiSelect === true;
  const onSubmitChip = hasTabs && tabIndex === submitTabIndex;

  // 任意 option 提供了 preview？整个题就走双栏，焦点项的 preview 渲染到右侧
  const anyPreview = !!currentQ?.options.some((o) => o.preview);
  const focusedOpt = currentQ?.options[states[tabIndex]?.optionIndex ?? 0];
  const focusedPreview = anyPreview ? focusedOpt?.preview ?? "" : "";

  const buildResponses = (cancelled: boolean): AskQuestionResponse[] => {
    if (cancelled) return questions.map(() => ({ cancelled: true, selections: [] }));
    return questions.map((q, qi) => ({
      cancelled: false,
      selections: Array.from(states[qi].selected)
        .sort((a, b) => a - b)
        .map((i) => q.options[i].label),
      notes: states[qi].notes,
    }));
  };

  const submit = () => request.resolve(buildResponses(false));
  const cancel = () => request.resolve(buildResponses(true));

  const updateState = (qi: number, mut: (s: QState) => QState) => {
    setStates((prev) => {
      const next = [...prev];
      next[qi] = mut(prev[qi]);
      return next;
    });
  };

  const toggleOption = (qi: number, oi: number) => {
    updateState(qi, (s) => {
      const sel = new Set(s.selected);
      if (sel.has(oi)) sel.delete(oi);
      else sel.add(oi);
      return { ...s, selected: sel };
    });
  };

  const selectSingleOption = (qi: number, oi: number) => {
    updateState(qi, (s) => ({ ...s, selected: new Set([oi]) }));
    if (!hasTabs) {
      request.resolve([
        {
          cancelled: false,
          selections: [questions[0].options[oi].label],
          notes: states[0].notes,
        },
      ]);
      return;
    }
    if (qi < N - 1) setTabIndex(qi + 1);
    else setTabIndex(submitTabIndex);
  };

  // 单题多选用的 Submit 行（=options.length，options 末尾）
  const singleQMultiSubmitRowIndex = !hasTabs && isMulti ? currentQ!.options.length : -1;
  const optionRowCount =
    !hasTabs && isMulti ? currentQ!.options.length + 1 : currentQ?.options.length ?? 0;

  const currentNotesEditing =
    tabIndex < N ? states[tabIndex].notesEditing : false;

  useInput((input, key) => {
    // ---------- notes 编辑模式 ----------
    if (currentNotesEditing) {
      if (key.escape) {
        updateState(tabIndex, (s) => ({ ...s, notesEditing: false, notesDraft: "" }));
        return;
      }
      if (key.return) {
        updateState(tabIndex, (s) => ({
          ...s,
          notesEditing: false,
          notes: s.notesDraft,
          notesDraft: "",
        }));
        return;
      }
      if (key.backspace || key.delete) {
        updateState(tabIndex, (s) => ({
          ...s,
          notesDraft: s.notesDraft.slice(0, -1),
        }));
        return;
      }
      if (key.ctrl || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.meta) {
        return;
      }
      if (input) {
        updateState(tabIndex, (s) => ({ ...s, notesDraft: s.notesDraft + input }));
      }
      return;
    }

    // ---------- picker 主模式 ----------
    if (key.escape) {
      cancel();
      return;
    }

    if (hasTabs && (key.tab || key.leftArrow || key.rightArrow)) {
      if (key.leftArrow || (key.shift && key.tab)) {
        setTabIndex((t) => Math.max(0, t - 1));
      } else {
        setTabIndex((t) => Math.min(submitTabIndex, t + 1));
      }
      return;
    }

    if (onSubmitChip) {
      if (key.return) submit();
      return;
    }

    const qi = tabIndex;
    const s = states[qi];

    if (key.upArrow) {
      updateState(qi, (st) => ({ ...st, optionIndex: Math.max(0, st.optionIndex - 1) }));
      return;
    }
    if (key.downArrow) {
      updateState(qi, (st) => ({
        ...st,
        optionIndex: Math.min(optionRowCount - 1, st.optionIndex + 1),
      }));
      return;
    }
    // n —— 进入 notes 编辑（任何 picker 题都允许，对齐 Claude Code）
    if (input === "n" && !key.ctrl && !key.meta) {
      updateState(qi, (st) => ({
        ...st,
        notesEditing: true,
        notesDraft: st.notes,
      }));
      return;
    }
    if (key.return) {
      if (!hasTabs && isMulti && s.optionIndex === singleQMultiSubmitRowIndex) {
        submit();
        return;
      }
      if (isMulti) toggleOption(qi, s.optionIndex);
      else selectSingleOption(qi, s.optionIndex);
      return;
    }
    if (isMulti && input === " " && s.optionIndex !== singleQMultiSubmitRowIndex) {
      toggleOption(qi, s.optionIndex);
    }
  });

  // ---------- render ----------

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider />
      {hasTabs && (
        <Box marginTop={0}>
          <TabBar questions={questions} states={states} tabIndex={tabIndex} />
        </Box>
      )}

      {tabIndex < N && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{questions[tabIndex].question}</Text>
          <Box flexDirection="row" marginTop={1}>
            <Box flexDirection="column" flexGrow={anyPreview ? 0 : 1} flexShrink={0} marginRight={anyPreview ? 2 : 0}>
              <OptionsList
                options={questions[tabIndex].options}
                focusedIndex={states[tabIndex].optionIndex}
                selected={states[tabIndex].selected}
                isMulti={isMulti}
                submitRowIndex={singleQMultiSubmitRowIndex}
              />
            </Box>
            {anyPreview && (
              <Box flexGrow={1} minWidth={PREVIEW_MIN_WIDTH}>
                <PreviewPanel content={focusedPreview} />
              </Box>
            )}
          </Box>
          <NotesLine
            notes={states[tabIndex].notes}
            editing={states[tabIndex].notesEditing}
            draft={states[tabIndex].notesDraft}
          />
        </Box>
      )}

      {onSubmitChip && (
        <Box flexDirection="column" marginTop={1}>
          <SubmitPreview questions={questions} states={states} />
        </Box>
      )}

      <Divider />
      <Box>
        <Text dimColor>{hintLine(hasTabs, isMulti, currentNotesEditing)}</Text>
      </Box>
    </Box>
  );
}

// ---------- subcomponents ----------

function Divider() {
  // 占满终端宽度的水平细线——用 box 的 borderTop 模拟最简单
  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" />
  );
}

function TabBar({
  questions,
  states,
  tabIndex,
}: {
  questions: AskQuestion[];
  states: QState[];
  tabIndex: number;
}) {
  const submitIndex = questions.length;
  const canLeft = tabIndex > 0;
  const canRight = tabIndex < submitIndex;
  return (
    <Box flexDirection="row" flexWrap="wrap">
      <Box marginRight={1}>
        <Text dimColor={!canLeft}>{"←"}</Text>
      </Box>
      {questions.map((q, i) => {
        const focused = i === tabIndex;
        const isMulti = q.multiSelect === true;
        const count = states[i].selected.size;
        const answered = count > 0;
        const mark = answered ? (isMulti ? `[${count}]` : "✔") : "□";
        return (
          <Box key={i} marginRight={TAB_GAP}>
            <Text
              backgroundColor={focused ? FOCUS_BG : undefined}
              color={focused ? FOCUS_FG : undefined}
              bold={focused}
              dimColor={!focused}
            >
              {` ${mark} ${q.header} `}
            </Text>
          </Box>
        );
      })}
      <Box marginRight={1}>
        <Text
          backgroundColor={tabIndex === submitIndex ? FOCUS_BG : undefined}
          color={tabIndex === submitIndex ? FOCUS_FG : SUBMIT_COLOR}
          bold={tabIndex === submitIndex}
          dimColor={tabIndex !== submitIndex}
        >
          {" ✔ Submit "}
        </Text>
      </Box>
      <Text dimColor={!canRight}>{"→"}</Text>
    </Box>
  );
}

function OptionsList({
  options,
  focusedIndex,
  selected,
  isMulti,
  submitRowIndex,
}: {
  options: AskQuestion["options"];
  focusedIndex: number;
  selected: Set<number>;
  isMulti: boolean;
  submitRowIndex: number;
}) {
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const focused = i === focusedIndex;
        const checked = selected.has(i);
        return (
          <Box key={i} flexDirection="column">
            <Box flexDirection="row">
              <Text color={POINTER_COLOR} bold>
                {focused ? "› " : "  "}
              </Text>
              {isMulti && (
                <Text color={checked ? "green" : undefined}>{checked ? "[x] " : "[ ] "}</Text>
              )}
              <Text dimColor>{`${i + 1}. `}</Text>
              <Text color={focused ? POINTER_COLOR : undefined} bold={focused}>
                {opt.label}
              </Text>
            </Box>
            {opt.description && (
              <Box marginLeft={isMulti ? 6 : 5}>
                <Text dimColor wrap="truncate-end">
                  {opt.description}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      {submitRowIndex >= 0 && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={POINTER_COLOR} bold>
            {focusedIndex === submitRowIndex ? "› " : "  "}
          </Text>
          <Text
            color={focusedIndex === submitRowIndex ? SUBMIT_COLOR : undefined}
            bold={focusedIndex === submitRowIndex}
            dimColor={focusedIndex !== submitRowIndex}
          >
            {`── Submit (${selected.size} selected)`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function PreviewPanel({ content }: { content: string }) {
  const lines = content ? content.split("\n") : ["(no preview)"];
  return (
    <Box
      borderStyle="round"
      borderColor={PREVIEW_BORDER}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
    >
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end" dimColor={!content}>
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

function NotesLine({
  notes,
  editing,
  draft,
}: {
  notes: string;
  editing: boolean;
  draft: string;
}) {
  if (editing) {
    return (
      <Box marginTop={1} flexDirection="row">
        <Text color={NOTES_LABEL_COLOR} bold>
          {"Notes: "}
        </Text>
        <Text>{draft}</Text>
        <Text color={POINTER_COLOR}>{"▎"}</Text>
        <Box flexGrow={1} marginLeft={2}>
          <Text dimColor>{"(Enter to save · Esc to discard)"}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="row" justifyContent="center">
      <Text color={NOTES_LABEL_COLOR} bold>
        {"Notes: "}
      </Text>
      {notes ? (
        <Text>{notes}</Text>
      ) : (
        <Text dimColor>{"press n to add notes"}</Text>
      )}
    </Box>
  );
}

function SubmitPreview({
  questions,
  states,
}: {
  questions: AskQuestion[];
  states: QState[];
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Review</Text>
      {questions.map((q, qi) => {
        const sel = Array.from(states[qi].selected)
          .sort((a, b) => a - b)
          .map((i) => q.options[i].label);
        const notes = states[qi].notes.trim();
        return (
          <Box key={qi} flexDirection="column" marginLeft={2}>
            <Box flexDirection="row">
              <Text color="yellow">{`${q.header}: `}</Text>
              <Text dimColor={sel.length === 0}>
                {sel.length > 0 ? sel.join(", ") : "(no answer)"}
              </Text>
            </Box>
            {notes && (
              <Box marginLeft={2} flexDirection="row">
                <Text color={NOTES_LABEL_COLOR}>{"notes: "}</Text>
                <Text dimColor>{notes}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function hintLine(hasTabs: boolean, isMulti: boolean, editingNotes: boolean): string {
  if (editingNotes) {
    return "Enter to save · Esc to discard · backspace to delete";
  }
  const parts: string[] = ["Enter to select", "↑/↓ to navigate", "n to add notes"];
  if (hasTabs) parts.push("Tab to switch questions");
  if (isMulti) parts.push("Space to toggle");
  parts.push("Esc to cancel");
  return parts.join(" · ");
}
