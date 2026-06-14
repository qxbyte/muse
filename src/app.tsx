/**
 * Ink 根组件：banner + 消息历史 + 输入框 + 流式响应 + slash 命令调度。
 *
 * SlashActions 在这里注入。LLM client / settings / modelsRegistry 都是 mutable state，
 * /model /config reload 通过 setLLM / setSettings / setModelsRegistry 触发 Agent 重建，
 * messages 通过 messagesRef 跨重建保留。
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { BgTextInput, stringWidth } from "./components/BgTextInput.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pickBanner } from "./components/StartupBanner.js";
import { MessageView, BatchedToolBlock, BATCHABLE_TOOLS, TodoList, extractTodos, extractListTitle, type BatchedToolUse } from "./components/MessageView.js";
import { PermissionPrompt, type PermissionRequest } from "./components/PermissionPrompt.js";
import { ModelSelector, type ModelPickerRequest } from "./components/ModelSelector.js";
import { SessionSelector, type SessionPickerRequest } from "./components/SessionSelector.js";
import { QuestionPicker, type QuestionPickerRequest } from "./components/QuestionPicker.js";
import { BtwOverlay, type BtwRequest } from "./components/BtwOverlay.js";
import { SlashAutocomplete } from "./components/SlashAutocomplete.js";
import { AtFileAutocomplete } from "./components/AtFileAutocomplete.js";
import { queryAtCandidates, type AtCandidate } from "./preprocess/input/at-source.js";
import { PermissionModeBar } from "./components/PermissionModeBar.js";
import { FooterStatus } from "./components/FooterStatus.js";
import { ProgressBanner, type ProgressState } from "./components/ProgressBanner.js";
import { StatusLine } from "./components/StatusLine.js";
import { DOT } from "./components/MessageView.js";
import { StreamingMarkdown } from "./components/StreamingMarkdown.js";
import { setTerminalTitle, resetTerminalTitle } from "./ui/termTitle.js";
import type { LLMClient } from "./llm/types.js";
import { createLLMClient, createLLMClientFromModelEntry, setActiveModelEnv } from "./llm/client.js";
import type { ToolRegistry } from "./tools/registry.js";
import { PermissionGate, type PermissionMode, type PermissionDecision } from "./permission/index.js";
import { Session, type SessionSummary } from "./session/jsonl.js";
import { Agent } from "./loop/agent.js";
import { loadMemoryIndex } from "./loop/memory.js";
import { loadHierarchy, type HierarchyLayer } from "./loop/hierarchy.js";
import { buildMemoryIndex, type MemoryIndex } from "./loop/memory-index.js";
import { TodoStore } from "./loop/todos.js";
import { InputPipeline, createInputCtx, buildUserMessage, type InputCtx } from "./preprocess/input/index.js";
import { RequestPipeline } from "./preprocess/request/index.js";
import { ResultPipeline } from "./preprocess/result/index.js";
import { runHooks } from "./preprocess/hooks.js";
import { PipelineBlockedError } from "./preprocess/pipeline.js";
import { loadSettings } from "./config/index.js";
import { VERSION } from "./version.js";
import { loadModelsRegistry, findEntry, type ModelEntry, type ModelsRegistry } from "./config/models.js";
import type { Message, ToolMessage, TokenUsage, ContentPart, ToolUsePart } from "./types/index.js";
import type { Settings } from "./config/types.js";
import {
  BUILTIN_SLASH_COMMANDS,
  SlashRegistry,
  type SlashActions,
  type SlashCommand,
  type SlashCommandResult,
} from "./slash/index.js";
import { skillsToSlashCommands } from "./slash/skill-commands.js";

export interface AppProps {
  llm: LLMClient;
  tools: ToolRegistry;
  permissions: PermissionGate;
  session: Session;
  settings: Settings;
  settingsSources: string[];
  modelsRegistry?: ModelsRegistry;
  modelsSources: string[];
  skillRegistry?: import("./skills/types.js").SkillRegistry;
  /** plugin 经 main register 贡献的 slash 命令(已 <plugin>: namespace);Plugins v0.4。 */
  pluginSlashCommands?: SlashCommand[];
  mcpManager?: import("./mcp/index.js").MCPManager;
  cwd: string;
  lang: "en" | "zh-CN";
  showBanner: boolean;
  initialMessages?: Message[];
}

interface UIState {
  history: Message[];
  streamingText: string;
  status: "idle" | "streaming" | "tool";
  /** Esc 主动中断后的灰字提示文字(null 表示不显示);下次 user_submit 自动清。 */
  stoppedNote: string | null;
  /** 当前正在跑的工具名（onToolCallStart 设置；下一次 stream_delta 或 turn_end 清空）。 */
  runningTool: string | null;
  /** 最近一次 onToolCallStart 的 tool_use id;BatchedToolBlock 据此选 active row。
   *  语义:"hold 上一个直到下一个真的开始"——LLM 思考 / 等权限 / hook 期间继续显示
   *  最近一次开始执行过的 row,避免 firstPending 立刻跳到下一个未启动的工具。
   *  user_submit 时清零(新 turn 不复用旧 id)。 */
  lastStartedToolId: string | null;
  /** session 累计 token（/cost 用），不是本轮快照——本轮快照走 turn* 引用 */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 本轮起点（user_submit 触发时 Date.now()），StatusLine 用；idle 时为 0 */
  turnStartTime: number;
  /** 本轮首次 text-delta 时间，StatusLine 显示 "thought for" 用；null 表示还未流出 text */
  turnFirstTextTime: number | null;
  /** 本轮已累计 input tokens（多轮 tool loop 累加） */
  turnInputTokens: number;
  /** history[0..stableUntilIdx-1] 已属过往 turn,可走 Static(Ink 一次 emit 不再重画),
   *  消除每次 tool result 到位时的全 history 重渲染闪屏。每次 user_submit 时更新。 */
  stableUntilIdx: number;
  /** 本轮 sticky TodoList 的"起点":只显示 history[todosSinceTurnIdx..] 之间最新一次 TodoWrite 的 todos。
   *  每次 user_submit 时重置到当前 history 长度——旧 turn 的 TodoList 立即从底部消失。
   *  这样实现 "TodoList 固定在输入框上方,跨工具调用持续可见" 的体验。 */
  todosSinceTurnIdx: number;
  /** turn 结束标记:每次 onTurnEnd 记录"该 turn 结束时 history 长度 + 时长",
   *  渲染时在对应位置插入 `✶ Churned for Xm Ys` 灰色行(turn 末尾摘要)。
   *  不进 session JSONL,resume 时旧 turn 的 churned 标记会丢,新 turn 仍会记录。 */
  turnEnds: Array<{ atHistoryLen: number; durationMs: number }>;
}

type UIAction =
  | { type: "user_submit"; stableUntil: number }
  | { type: "history_set"; messages: Message[] }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_reset" }
  | { type: "set_status"; status: UIState["status"] }
  | { type: "tool_start"; name: string; id: string }
  | { type: "add_usage"; usage: TokenUsage }
  | { type: "estimate"; inputTokens: number }
  | { type: "set_stopped"; note: string | null }
  | { type: "record_turn_end"; atHistoryLen: number; durationMs: number };

function reducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "user_submit":
      return {
        ...state,
        streamingText: "",
        status: "streaming",
        runningTool: null,
        turnStartTime: Date.now(),
        turnFirstTextTime: null,
        turnInputTokens: 0,
        stoppedNote: null,           // 新一轮开始,清掉上一轮 abort 残留提示
        stableUntilIdx: action.stableUntil, // 之前所有 turn 落定,可以丢进 Static
        lastStartedToolId: null,     // 新 turn 不复用旧 tool id
        todosSinceTurnIdx: action.stableUntil, // 旧 todos 立即从底部消失,等新 turn 的 TodoWrite
      };
    case "history_set": {
      // 智能去重:如果 history 末尾的 assistant message 已经包含 streamingText 的内容,
      // 自动清空 streamingText 避免"屏幕上+history 各显示一份"的重复。
      // 这条主要给 abort 路径用:abort 不 stream_reset → streamingText 保留显示;
      // 一旦 Agent 把已流出 text push 进 history(可能含 [interrupted] 标识),自动接管显示。
      let nextStreamingText = state.streamingText;
      if (state.streamingText.trim()) {
        const last = action.messages[action.messages.length - 1];
        if (last?.role === "assistant" && Array.isArray(last.content)) {
          const lastText = last.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          if (lastText.includes(state.streamingText.trim())) {
            nextStreamingText = "";
          }
        }
      }
      // 自动推进 stableUntilIdx:缩短 dynamic 区高度,缓解长 turn 内 Ink 整树重绘闪屏。
      // 策略:倒着找"最后一个含未完成 tool_use"的 assistant message idx;它本身 + 之后的
      //       tool result 留 dynamic(active batch 还在变),其余进 Static。无未完成 → 全 Static。
      // 副作用:Ink Static 增量 commit 时已完成 batch 整体上推到 stdout 顶部 — 视觉上像
      //       "滚屏",但比每 16ms 整段 dynamic 重画闪屏好。
      let nextStable = state.stableUntilIdx;
      let activeAssistantIdx = -1;
      for (let i = action.messages.length - 1; i >= 0; i--) {
        const m = action.messages[i];
        if (m.role === "assistant" && Array.isArray(m.content)) {
          const toolUses = m.content.filter(
            (p): p is { type: "tool_use"; id: string; name: string; args: unknown } =>
              p.type === "tool_use",
          );
          if (toolUses.length > 0) {
            const allDone = toolUses.every((p) =>
              action.messages.some(
                (mm) => mm.role === "tool" && (mm as { toolUseId?: string }).toolUseId === p.id,
              ),
            );
            if (!allDone) activeAssistantIdx = i;
            break;
          }
        }
      }
      if (activeAssistantIdx >= 0) {
        nextStable = Math.max(nextStable, activeAssistantIdx);
      } else {
        nextStable = Math.max(nextStable, action.messages.length);
      }
      return {
        ...state,
        history: action.messages,
        streamingText: nextStreamingText,
        stableUntilIdx: nextStable,
      };
    }
    case "stream_delta":
      // 文本流出意味着 LLM 在思考 / 回话——若刚才在 tool 阶段，自然过渡为 streaming
      // 第一次流出时打 turnFirstTextTime 时间戳（"thought for" 用），冻结不再变
      return {
        ...state,
        streamingText: state.streamingText + action.delta,
        status: state.status === "tool" ? "streaming" : state.status,
        runningTool: null,
        turnFirstTextTime: state.turnFirstTextTime ?? Date.now(),
      };
    case "stream_reset":
      return { ...state, streamingText: "" };
    case "set_status":
      return {
        ...state,
        status: action.status,
        runningTool: action.status === "tool" ? state.runningTool : null,
      };
    case "tool_start":
      return { ...state, status: "tool", runningTool: action.name, lastStartedToolId: action.id };
    case "add_usage":
      return {
        ...state,
        // session 累计:每次 LLM call 的 input/output 都累加,代表本次会话总计费量
        inputTokens: state.inputTokens + action.usage.inputTokens,
        outputTokens: state.outputTokens + action.usage.outputTokens,
        totalTokens: state.totalTokens + action.usage.totalTokens,
        // 本轮 ctx 快照:用最新一次 LLM call 的 inputTokens 覆盖,代表"当前 context 占用"。
        // 不累加(累加错把多轮 tool loop 的每次 input 叠在一起,ctx% 爆表)。
        turnInputTokens: action.usage.inputTokens,
      };
    case "estimate":
      // 流式开始前的估算,只更新本轮 ctx 快照,不进 session 累计
      return { ...state, turnInputTokens: action.inputTokens };
    case "set_stopped":
      return { ...state, stoppedNote: action.note };
    case "record_turn_end":
      return {
        ...state,
        turnEnds: [
          ...state.turnEnds,
          { atHistoryLen: action.atHistoryLen, durationMs: action.durationMs },
        ],
      };
  }
}

export function App({
  llm: initialLLM,
  tools,
  permissions: initialPermissions,
  session,
  settings: initialSettings,
  settingsSources: initialSources,
  modelsRegistry: initialModelsRegistry,
  skillRegistry,
  pluginSlashCommands,
  mcpManager,
  cwd,
  lang,
  showBanner,
  initialMessages,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const [llm, setLLM] = useState<LLMClient>(initialLLM);
  const [permissions, setPermissions] = useState<PermissionGate>(initialPermissions);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [settingsSources, setSettingsSources] = useState<string[]>(initialSources);
  const [modelsRegistry, setModelsRegistry] = useState<ModelsRegistry | undefined>(initialModelsRegistry);
  const [mode, setMode] = useState<PermissionMode>(initialPermissions.getMode());

  const [state, dispatch] = useReducer(reducer, {
    history: initialMessages ?? [],
    streamingText: "",
    status: "idle",
    runningTool: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turnStartTime: 0,
    turnFirstTextTime: null,
    turnInputTokens: 0,
    stoppedNote: null,
    // 启动时 initialMessages(/resume 加载或 --continue)整段当稳定历史:不会再改
    stableUntilIdx: initialMessages?.length ?? 0,
    lastStartedToolId: null,
    todosSinceTurnIdx: initialMessages?.length ?? 0,
    turnEnds: [],
  });

  const messagesRef = useRef<Message[]>(initialMessages ?? []);

  const [input, setInput] = useState("");
  // inputRemountKey 给 TextInput 做 remount —— ink-text-input 在 value 被外部强制修改时
  // cursor 不会跟随到末尾，bump 一个 key 让组件重挂载，新实例 cursor 默认在 value.length。
  // onChange 用 setInput 不能 bump（每次按键都 remount 会丢 cursor）；只有补全 / 清空等
  // "外部 setValue" 操作走 commitInput。
  const [inputRemountKey, setInputRemountKey] = useState(0);
  const commitInput = (value: string) => {
    setInput(value);
    setInputRemountKey((k) => k + 1);
  };
  // 粘贴 registry:大段粘贴的原文按 id 存这里,输入框里只显示 [Pasted text #N +M lines]
  // 占位符。提交时由 InputPipeline 的 paste-expand stage 还原成原文发给 LLM。
  // 用 ref 不用 state——内容只在 onPaste/onSubmit 的瞬时事件里读，不需要触发渲染。
  const pasteRegistryRef = useRef<{ map: Map<number, string>; nextId: number }>({
    map: new Map(),
    nextId: 1,
  });
  const handlePaste = useCallback((chunk: string): string => {
    const reg = pasteRegistryRef.current;
    const id = reg.nextId++;
    reg.map.set(id, chunk);
    const lines = chunk.split("\n").length;
    return `[Pasted text #${id} +${lines} lines]`;
  }, []);

  // 图片 registry:Cmd+V 直接粘图(BgTextInput 同步检测剪贴板)。
  // 输入框里只显示 [Image #N] 占位符,提交时由 InputPipeline 的
  // expand-image-placeholder stage 还原为 ImagePart。
  const imageRegistryRef = useRef<{
    map: Map<number, { data: Buffer; mediaType: "image/png" }>;
    nextId: number;
  }>({ map: new Map(), nextId: 1 });
  const handlePasteImage = useCallback((data: Buffer, mediaType: "image/png"): string => {
    const reg = imageRegistryRef.current;
    const id = reg.nextId++;
    reg.map.set(id, { data, mediaType });
    return `[Image #${id}]`;
  }, []);

  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [picker, setPicker] = useState<ModelPickerRequest | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerRequest | null>(null);
  const [questionPicker, setQuestionPicker] = useState<QuestionPickerRequest | null>(null);
  const [btwRequest, setBtwRequest] = useState<BtwRequest | null>(null);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const agentRef = useRef<Agent | null>(null);

  // 本轮 abort controller:handleSubmit 开始时新建,Esc 触发 abort,onTurnEnd 清空
  const turnAbortRef = useRef<AbortController | null>(null);

  // 双击 Esc rewind 检测:第一次 Esc 落入 idle 状态时记下时间戳;500ms 内再 Esc → rewind
  const lastEscRef = useRef<number>(0);
  const ESC_DOUBLE_WINDOW_MS = 500;
  const [escHint, setEscHint] = useState<string | null>(null); // "Press Esc again to rewind"

  // 引导(guidance)队列预览:模型在跑时用户继续提交的消息进 agent.enqueueGuidance,
  // 这里只是 UI 镜像供"↳ 引导"小框显示。Agent 主循环每轮 flushGuidance 后会触发
  // onGuidanceInjected → 这里清空。
  type GuidanceItem = string | ContentPart[];
  const [guidanceQueue, setGuidanceQueue] = useState<GuidanceItem[]>([]);

  // 输入历史：纯用户输入（不含 slash 命令），最旧 → 最新 push 到末尾
  // historyIndex: -1=未导航；0=最新；len-1=最旧
  const inputHistoryRef = useRef<string[]>(extractUserInputs(initialMessages ?? []));
  const historyIndexRef = useRef<number>(-1);
  const savedDraftRef = useRef<string>("");

  const slash = useMemo(() => {
    const r = new SlashRegistry();
    r.registerAll(BUILTIN_SLASH_COMMANDS);
    // 每个 skill 注册成一条 /<name>(扩展接入口 §五.7;撞内置名加 skill: 前缀)。
    if (skillRegistry) {
      r.registerAll(skillsToSlashCommands(skillRegistry.list(), (n) => r.get(n) !== undefined));
    }
    // plugin 经 main register 贡献的 slash(Plugins v0.4;已 <plugin>: namespace,撞名跳过)。
    for (const cmd of pluginSlashCommands ?? []) {
      if (r.get(cmd.name)) continue;
      r.register(cmd);
    }
    return r;
  }, [skillRegistry, pluginSlashCommands]);

  // input.startsWith("/") && 命令名阶段（无空格）→ 显示匹配候选
  const autocomplete = useMemo<{ matches: SlashCommand[]; query: string } | null>(() => {
    if (!input.startsWith("/")) return null;
    const body = input.slice(1);
    if (body.includes(" ")) return null;
    const query = body.toLowerCase();
    const all = slash.list();
    const matches = query
      ? all.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.aliases?.some((a) => a.toLowerCase().includes(query)),
        )
      : all;
    return { matches, query };
  }, [input, slash]);

  // 输入变化时把高亮索引夹回合法范围
  useEffect(() => {
    const len = autocomplete?.matches.length ?? 0;
    if (autocompleteIndex >= len) setAutocompleteIndex(0);
  }, [autocomplete, autocompleteIndex]);

  // @ 引用 fuzzy 补全。
  // 检测光标位置往前找最后一个 `@`,后面没有空白前的段是 query。input 为简化用
  // 整串末尾的 `@xxx` 段(不跟踪光标,与 SlashAutocomplete 一致)。
  const atQuery = useMemo<string | null>(() => {
    // slash 模式已激活时不触发 @
    if (input.startsWith("/")) return null;
    // 找最后一个 @,要求它前面是行首或空白
    const idx = input.lastIndexOf("@");
    if (idx < 0) return null;
    if (idx > 0 && !/\s/.test(input[idx - 1])) return null;
    const tail = input.slice(idx + 1);
    if (/\s/.test(tail)) return null;
    return tail;
  }, [input]);

  const [atMatches, setAtMatches] = useState<AtCandidate[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  // @skill mention(扩展接入口 §十):已加载 skill 名,供 @ 候选置顶 + 提交期激活检测。
  const skillNames = useMemo(() => skillRegistry?.list().map((s) => s.name), [skillRegistry]);
  useEffect(() => {
    if (atQuery === null) {
      setAtMatches([]);
      return;
    }
    let cancelled = false;
    queryAtCandidates(cwd, atQuery, skillNames)
      .then((cands) => {
        if (!cancelled) setAtMatches(cands);
      })
      .catch(() => {
        if (!cancelled) setAtMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [atQuery, cwd, skillNames]);
  useEffect(() => {
    if (atIndex >= atMatches.length) setAtIndex(0);
  }, [atMatches, atIndex]);

  /** 选中候选 → 替换 input 末尾的 @query 段。dir 末尾加 `/` 让用户继续展开。 */
  const acceptAtCandidate = useCallback(
    (cand: AtCandidate) => {
      const idx = input.lastIndexOf("@");
      if (idx < 0) return;
      const prefix = input.slice(0, idx);
      const replacement = cand.isDir ? `@${cand.rel}/` : `@${cand.rel} `;
      commitInput(prefix + replacement);
    },
    [input],
  );

  // 终端 tab/window 标题：idle 静态项目名，busy 时旋转 spinner + 工具名。
  // 100ms tick / 10 帧 braille——切到别的窗口也能从 dock 看出 muse 还在跑。
  useEffect(() => {
    const project = basename(cwd) || "muse";
    const baseIdle = `muse · ${project}`;

    if (state.status === "idle") {
      setTerminalTitle(baseIdle);
      return;
    }

    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const id = setInterval(() => {
      const frame = FRAMES[i % FRAMES.length];
      const tail = state.runningTool ? ` · ${state.runningTool}` : "";
      setTerminalTitle(`${frame} muse · ${project}${tail}`);
      i++;
    }, 100);
    return () => clearInterval(id);
  }, [state.status, state.runningTool, cwd]);

  // 卸载时清标题（避免退出后 tab 留着旧 spinner 字符）
  useEffect(() => {
    return () => resetTerminalTitle();
  }, []);

  const [memoryIndex, setMemoryIndex] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    loadMemoryIndex(cwd).then((idx) => {
      if (!cancelled) setMemoryIndex(idx);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // II-1:hierarchy(MUSE.md / AGENTS.md 5 层)— turn 起前一次性加载,变更 cwd 时重读
  const [hierarchy, setHierarchy] = useState<HierarchyLayer[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadHierarchy(cwd).then((layers) => {
      if (!cancelled) setHierarchy(layers);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // II-5:memory embedding index(启用时启动 + cwd / settings 变化时重建,失败完全降级)
  const [memoryEmbeddingIndex, setMemoryEmbeddingIndex] = useState<MemoryIndex | undefined>(undefined);
  const [memoryEmbeddingError, setMemoryEmbeddingError] = useState<string | undefined>(undefined);
  const embeddingEnabled = settings.memory?.embedding?.enabled === true;
  const embeddingProviderKind = settings.memory?.embedding?.provider;
  useEffect(() => {
    if (!embeddingEnabled) {
      setMemoryEmbeddingIndex(undefined);
      setMemoryEmbeddingError(undefined);
      return;
    }
    let cancelled = false;
    buildMemoryIndex(cwd, { config: settings.memory?.embedding })
      .then((idx) => {
        if (cancelled) return;
        setMemoryEmbeddingIndex(idx);
        setMemoryEmbeddingError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setMemoryEmbeddingIndex(undefined);
        setMemoryEmbeddingError((err as Error).message ?? String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, embeddingEnabled, embeddingProviderKind, settings.memory?.embedding?.preset, settings.memory?.embedding?.model, settings.memory?.embedding?.dim, settings.memory?.embedding?.baseUrl]);

  // SessionStart / SessionEnd hooks
  const [sessionExtraPrompt, setSessionExtraPrompt] = useState<string>("");
  const turnCountRef = useRef<number>(0);
  const sessionStartTimeRef = useRef<number>(Date.now());
  /** 本轮开始时刻;handleSubmit 入口设置,onTurnEnd 计算 churned duration 用。
   *  用 ref 而非闭包 state(state 在异步 onTurnEnd 闭包里可能 stale)。 */
  const turnStartTimeRef = useRef<number>(0);
  useEffect(() => {
    let cancelled = false;
    runHooks(
      "SessionStart",
      { cwd, mode: permissions.getMode(), modelId: llm.model },
      settings.hooks,
    )
      .then((out) => {
        if (cancelled) return;
        if (typeof out.extraSystemPrompt === "string") setSessionExtraPrompt(out.extraSystemPrompt);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // SessionEnd:fire-and-forget
      const durationMs = Date.now() - sessionStartTimeRef.current;
      runHooks(
        "SessionEnd",
        { durationMs, turnCount: turnCountRef.current },
        settings.hooks,
      ).catch(() => {});
    };
  }, [cwd, llm.model, settings.hooks]);

  useEffect(() => {
    const todos = new TodoStore();
    const requestPipeline = RequestPipeline({
      disable: settings.preprocess?.disable,
    });
    const resultPipeline = ResultPipeline({
      disable: settings.preprocess?.disable,
    });

    const agent = new Agent({
      llm,
      tools,
      permissions,
      session,
      cwd,
      todos,
      skillRegistry,
      mcpManager,
      requestPipeline,
      requestServices: {
        todos,
        memoryIndex,
        hierarchy,
        memoryEmbeddingIndex,
        memoryEmbeddingTopK: settings.memory?.embedding?.topK,
        memoryEmbeddingMinCount: settings.memory?.embedding?.minMemoryCount,
        skills: skillRegistry?.list(),
        toolRegistry: tools,
        lang,
        provider: llm.providerName,
        extraSystemPrompt: sessionExtraPrompt,
      },
      requestSettings: settings.preprocess?.request,
      resultPipeline,
      resultSettings: settings.preprocess?.result,
      hooks: settings.hooks,
      events: {
        onText: (delta) => dispatch({ type: "stream_delta", delta }),
        onToolCallStart: (id, name) => dispatch({ type: "tool_start", name, id }),
        // assistant 流刚结束、这一批 calls 已落到 messages 但 tool 还没开始执行：
        // 立刻同步 history，让所有 ⏺ Tool(...) 调用头一次性显示出来（之前要等第一个
        // result 才能见到任何东西，看起来像"卡死了"）
        onAssistantTurn: () => {
          const msgs = [...agent.getMessages()];
          messagesRef.current = msgs;
          dispatch({ type: "history_set", messages: msgs });
          dispatch({ type: "stream_reset" });
        },
        // 每个 tool result 到位就同步：result 立刻挂到对应 ⏺ 调用的 └ 树枝下方
        onToolResult: () => {
          const msgs = [...agent.getMessages()];
          messagesRef.current = msgs;
          dispatch({ type: "history_set", messages: msgs });
          dispatch({ type: "set_status", status: "streaming" });
        },
        onUsage: (usage: TokenUsage) => dispatch({ type: "add_usage", usage }),
        onEstimate: (inputTokens) => dispatch({ type: "estimate", inputTokens }),
        onTurnEnd: () => {
          turnCountRef.current++;
          const msgs = [...agent.getMessages()];
          messagesRef.current = msgs;
          dispatch({ type: "history_set", messages: msgs });
          // 记录本 turn 的 churned duration(start 来自 handleSubmit 设的 ref);
          // 渲染时根据 atHistoryLen 在对应位置插入 "✶ Churned for Xm Ys" 灰色行
          if (turnStartTimeRef.current > 0) {
            const duration = Date.now() - turnStartTimeRef.current;
            dispatch({
              type: "record_turn_end",
              atHistoryLen: msgs.length,
              durationMs: duration,
            });
            turnStartTimeRef.current = 0;
          }
          // abort 触发的 onTurnEnd 不主动 stream_reset:保留 streamingText 让用户看到已流出内容。
          // 上面 history_set 内含智能去重,如果 history 已包含该 text 会自动清 streamingText
          // 避免双显示;Agent 没成功 push 时(corner case),streamingText 兜底保留。
          if (!turnAbortRef.current?.signal.aborted) {
            dispatch({ type: "stream_reset" });
          }
          dispatch({ type: "set_status", status: "idle" });
        },
        // Agent 在新一轮 stream 启动前 flush 队列 + 注入 messages → 清 UI 镜像。
        // 同时 history 也已经被 Agent push 了那条 user 消息,这里同步一下让"引导内容"
        // 立刻在历史里以普通 user message 形式出现(便于用户回看)。
        onGuidanceInjected: () => {
          setGuidanceQueue([]);
          const msgs = [...agent.getMessages()];
          messagesRef.current = msgs;
          dispatch({ type: "history_set", messages: msgs });
        },
        onError: (err) => {
          if (turnAbortRef.current?.signal.aborted || isAbortLike(err)) {
            // 不 stream_reset,保留已流出内容;reducer 内 history_set 智能去重
            dispatch({ type: "set_status", status: "idle" });
            dispatch({ type: "set_stopped", note: "⏹ Stopped by Esc" });
            return;
          }
          // 不再拼 [error] 到 streamingText,改成灰字 stoppedNote(跟 Esc 提示同款),
          // 避免红字跟模型回答混在同一个 ● 块里。下一次 user_submit 自动清。
          dispatch({ type: "set_stopped", note: formatErrorForUser(err.message) });
          dispatch({ type: "set_status", status: "idle" });
        },
        onPermissionRequest: (toolName, args, summary) =>
          new Promise<PermissionDecision>((resolve) => {
            setPending({ toolName, args, summary, resolve });
          }),
        onAskQuestions: (questions) =>
          new Promise((resolve) => {
            setQuestionPicker({ questions, resolve });
          }),
      },
    });
    agent.setMessages(messagesRef.current);
    agentRef.current = agent;
  }, [llm, tools, permissions, session, cwd, lang, memoryIndex, hierarchy, memoryEmbeddingIndex, sessionExtraPrompt]);

  // 键盘：Ctrl+C 全局退出 + Shift+Tab 循环切 permission mode + autocomplete ↑↓ Tab Esc 导航
  useInput(
    (inputKey, key) => {
      if (key.ctrl && inputKey === "c") {
        exit();
        return;
      }
      if (key.shift && key.tab) {
        const next = permissions.cycleMode();
        setMode(next);
        return;
      }

      // Esc 处理(优先级高于补全/历史,但低于 autocomplete 自身的 Esc 处理):
      //   - 非 idle 状态:
      //     · 若有"引导"队列待注入 → 先清队列(轻撤销),不中断当前 turn
      //     · 队列空 → 中断当前 stream / 工具执行
      //   - idle 状态(无 autocomplete):双击 500ms 内 rewind 上一轮
      if (key.escape && !(autocomplete && autocomplete.matches.length > 0) && !(atQuery !== null && atMatches.length > 0)) {
        if (state.status !== "idle") {
          if (guidanceQueue.length > 0) {
            agentRef.current?.clearGuidance();
            setGuidanceQueue([]);
            setEscHint("guidance cleared");
            setTimeout(() => setEscHint(null), 1500);
            return;
          }
          turnAbortRef.current?.abort();
          setEscHint(null);
          return;
        }
        // idle 状态:双击检测
        const now = Date.now();
        if (now - lastEscRef.current < ESC_DOUBLE_WINDOW_MS) {
          // 双击 → rewind
          lastEscRef.current = 0;
          setEscHint(null);
          const ok = rewindLastTurn();
          if (!ok) setEscHint("(nothing to rewind)");
          return;
        }
        // 单击 → 提示 + 等第二下
        lastEscRef.current = now;
        setEscHint("Press Esc again to rewind last turn");
        setTimeout(() => {
          if (Date.now() - lastEscRef.current >= ESC_DOUBLE_WINDOW_MS) {
            setEscHint(null);
          }
        }, ESC_DOUBLE_WINDOW_MS + 50);
        return;
      }

      if (autocomplete && autocomplete.matches.length > 0) {
        const len = autocomplete.matches.length;
        if (key.upArrow) {
          setAutocompleteIndex((i) => (i - 1 + len) % len);
        } else if (key.downArrow) {
          setAutocompleteIndex((i) => (i + 1) % len);
        } else if (key.tab) {
          const picked = autocomplete.matches[autocompleteIndex];
          if (picked) commitInput(`/${picked.name}`);
        } else if (key.escape) {
          commitInput("");
        }
        return;
      }

      // @ 引用自动补全
      if (atQuery !== null && atMatches.length > 0) {
        const len = atMatches.length;
        if (key.upArrow) {
          setAtIndex((i) => (i - 1 + len) % len);
        } else if (key.downArrow) {
          setAtIndex((i) => (i + 1) % len);
        } else if (key.tab || (key.return && false /* Enter 由 onSubmit 处理 */)) {
          // Tab 接受当前焦点
          const picked = atMatches[atIndex];
          if (picked) acceptAtCandidate(picked);
        } else if (key.escape) {
          // 退出补全 picker:删掉 @ 之后的字符,保留 @
          const idx = input.lastIndexOf("@");
          if (idx >= 0) commitInput(input.slice(0, idx));
        }
        return;
      }

      // autocomplete 关闭时:↑/↓ 翻输入历史
      const hist = inputHistoryRef.current;
      if (key.upArrow && hist.length > 0) {
        const cur = historyIndexRef.current;
        if (cur === -1) savedDraftRef.current = input;
        const next = Math.min(cur + 1, hist.length - 1);
        historyIndexRef.current = next;
        commitInput(hist[hist.length - 1 - next] ?? "");
      } else if (key.downArrow) {
        const cur = historyIndexRef.current;
        if (cur === -1) return;
        const next = cur - 1;
        historyIndexRef.current = next;
        if (next === -1) commitInput(savedDraftRef.current);
        else commitInput(hist[hist.length - 1 - next] ?? "");
      }
    },
    // 模型在跑时也要响应键盘（让用户能 Ctrl+C / Shift+Tab / autocomplete 导航）；
    // 仅模态弹起时让出键盘所有权
    { isActive: !pending && !picker && !sessionPicker && !questionPicker && !btwRequest },
  );

  // 输入框：picker 类模态弹起时仍保持可见但失焦（"Chat about this" 风格），
  // 真正抢键盘的 PermissionPrompt / ModelSelector / SessionSelector / BtwOverlay 才完全隐藏
  const acceptingInput = pending === null && picker === null && sessionPicker === null && questionPicker === null && btwRequest === null;
  const inputVisible = pending === null && picker === null && sessionPicker === null && btwRequest === null;
  const inputPlaceholder = questionPicker ? "Chat about this" : undefined;

  const actions: SlashActions = useMemo(
    () => ({
      setMessages: (msgs) => {
        messagesRef.current = msgs;
        agentRef.current?.setMessages(msgs);
        dispatch({ type: "history_set", messages: msgs });
      },
      pickModel: (items, currentId) =>
        new Promise<ModelEntry | null>((resolve) => {
          setPicker({ items, currentId, resolve });
        }),
      pickSession: (items, currentId) =>
        new Promise<SessionSummary | null>((resolve) => {
          setSessionPicker({ items, currentId, resolve });
        }),
      switchModel: async (modelId) => {
        if (!modelsRegistry) throw new Error("No models registry loaded.");
        const entry = findEntry(modelsRegistry, modelId);
        if (!entry) throw new Error(`Model id "${modelId}" not in registry.`);
        setActiveModelEnv(entry);
        const next = createLLMClientFromModelEntry(entry);
        setLLM(next);
        await persistActiveModel(modelId);
      },
      getMode: () => permissions.getMode(),
      setMode: (m) => {
        permissions.setMode(m);
        setMode(m);
      },
      showProgress: (opts) => {
        setProgress({
          title: opts.title,
          tips: opts.tips ?? [],
          getPercent: opts.getPercent ?? (() => 0),
          startTime: Date.now(),
        });
      },
      hideProgress: () => setProgress(null),
      askBtw: (question) =>
        new Promise<void>((resolve) => {
          // history 锁定在 /btw 触发的瞬间——后续即使主对话有新消息，/btw 看到的也是当时的快照
          setBtwRequest({ question, history: messagesRef.current, resolve });
        }),
      activateSkill: async (name) => {
        const agent = agentRef.current;
        if (!agent) return "agent not ready";
        // 注意:activateSkillByName 成功返回 null,不能用 `?? "agent not ready"`
        // 兜底(null 会被误判成错误);只在 agent 未就绪时返回该串。
        return agent.activateSkillByName(name);
      },
      openInEditor: (filePath) =>
        new Promise<void>((resolve, reject) => {
          // 让出 TTY 给外部编辑器(vi/vim/nano/code 等)。
          // Ink 暂停 raw mode → spawn editor with stdio:inherit → 退出后恢复。
          // vi 系编辑器会接管 stdin/stdout,Ink 自动暂停渲染;退出后 Ink 看到 stdin 恢复 redraw。
          const editor = process.env.VISUAL || process.env.EDITOR || "vi";
          try {
            if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
          } catch {}
          const child = spawn(editor, [filePath], { stdio: "inherit" });
          child.on("exit", (code) => {
            try {
              if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
            } catch {}
            if (code === 0) resolve();
            else reject(new Error(`editor "${editor}" exited with code ${code}`));
          });
          child.on("error", (err) => {
            try {
              if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
            } catch {}
            reject(new Error(`editor "${editor}" failed: ${err.message}`));
          });
        }),
      reloadSettings: async () => {
        const { settings: nextSettings, sources } = await loadSettings(cwd);
        const { registry: nextModels } = await loadModelsRegistry();
        setSettings(nextSettings);
        setSettingsSources(sources);
        setPermissions(new PermissionGate(nextSettings.permissions));
        setModelsRegistry(nextModels);

        const wantModel = nextSettings.llm?.model;
        if (wantModel && wantModel !== llm.model) {
          try {
            const entry = nextModels ? findEntry(nextModels, wantModel) : undefined;
            if (entry) {
              setActiveModelEnv(entry);
              setLLM(createLLMClientFromModelEntry(entry));
            } else if (nextSettings.llm?.provider) {
              setLLM(
                createLLMClient({
                  provider: nextSettings.llm.provider,
                  model: wantModel,
                  providers: nextSettings.providers ?? {},
                }),
              );
            }
          } catch {
            // 新配置当前不可用（缺 key 等）；保留原 LLM 不抛断流
          }
        }
        return { settings: nextSettings, sources };
      },
    }),
    [cwd, modelsRegistry, llm.model, permissions],
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const rawValue = value.trim();
      if (!rawValue) return;
      // 裸 "exit" 视同 "/exit",方便从 shell 习惯过来的用户直接退出
      const trimmed = rawValue === "exit" ? "/exit" : rawValue;

      // autocomplete 开 + 有候选 + 用户没在精确命名 → 补全到 input,不提交
      if (autocomplete && autocomplete.matches.length > 0) {
        const exact = autocomplete.matches.find(
          (c) => c.name === autocomplete.query || c.aliases?.includes(autocomplete.query),
        );
        if (!exact) {
          const picked = autocomplete.matches[autocompleteIndex] ?? autocomplete.matches[0];
          commitInput(`/${picked.name}`);
          return;
        }
      }

      // @ autocomplete 开 + 有候选 → Enter 接受焦点而非提交
      if (atQuery !== null && atMatches.length > 0) {
        const picked = atMatches[atIndex];
        if (picked) {
          acceptAtCandidate(picked);
          return;
        }
      }

      // InputPipeline:slash-dispatch / paste-expand / at-file-expand / at-image /
      //                template-expand / validate-length / redact-pre-scan
      const activeEntry = modelsRegistry ? findEntry(modelsRegistry, llm.model) : undefined;
      const inputCtx = createInputCtx({
        raw: trimmed,
        source: "tty",
        cwd,
        mode: permissions.getMode(),
        settings: settings.preprocess?.input,
        capabilities: { supportsImages: activeEntry?.supportsImages ?? false },
        skillNames,
      });
      const pipeline = InputPipeline({
        pasteRegistry: pasteRegistryRef.current.map,
        imageRegistry: imageRegistryRef.current.map,
        disable: settings.preprocess?.disable,
      });
      try {
        await pipeline.run(inputCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendAssistantText(`[input pipeline error] ${msg}`);
        commitInput("");
        return;
      }

      // pipeline 产出的告警(超长截断 / 脱敏命中 / @file 跳过等)显示给用户
      if (inputCtx.warnings.length > 0) {
        const msg = inputCtx.warnings.map((w) => `[${w.stage}] ${w.message}`).join("\n");
        appendAssistantText(msg);
      }

      // @skill mention(扩展接入口 §十):at-skill-expand 检测到的 skill 显式激活
      // (等价 /skill run,绕过 LLM 自决;允许 hidden skill)。slash 路径不涉及。
      if (!inputCtx.slashCommand && inputCtx.skillActivations.length > 0) {
        const agent = agentRef.current;
        const notes: string[] = [];
        for (const name of inputCtx.skillActivations) {
          // null=成功,不能用 `?? "agent not ready"`(会把成功误判为错误);分别处理。
          const reason = agent ? await agent.activateSkillByName(name) : "agent not ready";
          notes.push(reason ? `✦ skill "${name}" not activated: ${reason}` : `✦ skill "${name}" activated`);
        }
        if (notes.length > 0) appendAssistantText(notes.join("\n"));
      }

      // UserPromptSubmit hook:slash 命令不触发(slash 走系统自处理路径,不上 LLM)
      if (!inputCtx.slashCommand) {
        try {
          const hookOut = await runHooks(
            "UserPromptSubmit",
            { text: inputCtx.text, attachments: inputCtx.attachments, source: inputCtx.source },
            settings.hooks,
          );
          if (typeof hookOut.text === "string") inputCtx.text = hookOut.text;
        } catch (err) {
          if (err instanceof PipelineBlockedError) {
            appendAssistantText(`[blocked by UserPromptSubmit hook] ${err.reason}`);
            commitInput("");
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          appendAssistantText(`[UserPromptSubmit hook error] ${msg}`);
          commitInput("");
          return;
        }
      }

      if (inputCtx.slashCommand) {
        // 模型在跑时 slash 命令一律拒绝——/clear /compact /resume 会改 messages 与 agent
        // 正在跑的回复冲突;reduce 也无法把 slash 排到队列里执行(会污染 history 时序)。
        if (state.status !== "idle") {
          commitInput("");
          return;
        }
        const cmd = slash.get(inputCtx.slashCommand.name);
        commitInput("");
        if (!cmd) {
          appendAssistantText(`Unknown command: /${inputCtx.slashCommand.name}. Try /help.`);
          return;
        }
        try {
          const result = await cmd.execute({
            args: inputCtx.slashCommand.args,
            cwd,
            llm,
            session,
            settings,
            settingsSources,
            modelsRegistry,
            skillRegistry,
            mcpManager,
            history: messagesRef.current,
            tokens: {
              inputTokens: state.inputTokens,
              outputTokens: state.outputTokens,
              totalTokens: state.totalTokens,
            },
            listCommands: () => slash.list(),
            actions,
          });
          applySlashResult(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendAssistantText(`[error] /${inputCtx.slashCommand.name}: ${msg}`);
        }
        return;
      }

      commitInput("");
      // 推入历史(去重相邻重复),重置游标。历史里存原文(用户在 ↑ 翻历史时见原始 trimmed)。
      const hist = inputHistoryRef.current;
      if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
      if (hist.length > 200) hist.shift();
      historyIndexRef.current = -1;
      savedDraftRef.current = "";

      // pipeline 输出组装成 user content:无附件→string;有附件→ContentPart[]
      const userContent = buildUserMessage(inputCtx);

      // 阻断空消息:InputPipeline 把占位符 / 模板等全消掉后,可能 text 空 + 无 attachment;
      // 直接送 LLM 会让模型"自由发挥"(看到空 user message 自己猜要干嘛)。
      const isEmpty =
        typeof userContent === "string"
          ? userContent.trim().length === 0
          : userContent.every(
              (p) => p.type !== "file" && p.type !== "image" && (p.type !== "text" || p.text.trim().length === 0),
            );
      if (isEmpty) {
        appendAssistantText(
          inputCtx.warnings.length > 0
            ? `(empty message after preprocessing — see warnings above; nothing sent)`
            : `(empty message — nothing sent)`,
        );
        return;
      }

      // 模型在跑 → 进 Agent 的 guidance 队列(注入到当前 turn,不开新 turn)。
      // Agent 主循环下一轮 stream 启动前 flushGuidance 会把它合并成一条 user 消息
      // 塞进 messages,然后触发 onGuidanceInjected → 这里 setGuidanceQueue([]) 清预览。
      if (state.status !== "idle") {
        agentRef.current?.enqueueGuidance(userContent);
        setGuidanceQueue((q) => [...q, userContent]);
        return;
      }

      dispatch({ type: "user_submit", stableUntil: messagesRef.current.length });
      turnStartTimeRef.current = Date.now(); // churned duration 基准
      // 立刻把用户消息塞进可见历史,UX 上"瞬间出现"
      {
        const userMsg: Message = { role: "user", content: userContent };
        const next = [...messagesRef.current, userMsg];
        messagesRef.current = next;
        dispatch({ type: "history_set", messages: next });
      }
      // 新建本轮 abort controller,Esc 触发它 → Agent 内 LLM stream + 工具 execa 联动中断
      const ctrl = (turnAbortRef.current = new AbortController());
      try {
        await agentRef.current?.runTurn(userContent, ctrl.signal);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortLike(err)) {
          // 用户主动 Esc:Agent 内已经把已流出内容标 [interrupted] 持久化,这里只清屏
          dispatch({ type: "stream_reset" });
          dispatch({ type: "set_status", status: "idle" });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          dispatch({ type: "set_stopped", note: formatErrorForUser(msg) });
          dispatch({ type: "set_status", status: "idle" });
        }
      } finally {
        if (turnAbortRef.current === ctrl) turnAbortRef.current = null;
      }
    },
    [slash, cwd, llm, session, settings, settingsSources, modelsRegistry, state.inputTokens, state.outputTokens, state.totalTokens, state.status, actions, autocomplete, autocompleteIndex, atQuery, atMatches, atIndex, acceptAtCandidate, permissions],
  );

  function appendAssistantText(text: string) {
    const msg: Message = { role: "assistant", content: [{ type: "text", text }] };
    // 必须读 ref 而非闭包里的 state.history：上游可能刚通过 setMessages 改了历史
    // （/resume 加载 N 条 → applySlashResult 追加"Resumed..."），用 state.history
    // 会覆盖刚 load 进来的消息
    const next = [...messagesRef.current, msg];
    messagesRef.current = next;
    dispatch({ type: "history_set", messages: next });
  }

  function applySlashResult(result: SlashCommandResult) {
    if (result.exit) {
      // exit 带 display(/exit 的告别语):append 进 history → React 渲染 ● <text>,
      // 延后一帧再 unmount。Ink unmount 不主动清屏,最后一帧(含告别语)保留在终端。
      // 80ms = 5 帧,足够 React commit + Ink emit 完成。
      if (result.display !== undefined) {
        appendAssistantText(result.display);
        setTimeout(() => exit(), 80);
      } else {
        exit();
      }
      return;
    }
    if (result.display !== undefined) {
      appendAssistantText(result.display);
    }
  }

  /**
   * 双 Esc rewind:找最后一条 user message,把它的文本塞回输入框,删除它和它之后的所有消息。
   * 这是 "Double Esc time-machine" 形态的简化版(muse 没做 file checkpoint)。
   * 返 true 表示成功 rewind,false 表示没东西可 rewind。
   */
  function rewindLastTurn(): boolean {
    const msgs = messagesRef.current;
    // 倒着找最后一条 user message
    let userIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return false;
    const userMsg = msgs[userIdx];
    const text = typeof userMsg.content === "string"
      ? userMsg.content
      : userMsg.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
    // 删该 user message 自己 + 之后所有
    const next = msgs.slice(0, userIdx);
    messagesRef.current = next;
    agentRef.current?.setMessages(next);
    dispatch({ type: "history_set", messages: next });
    // 塞回输入框
    commitInput(text);
    return true;
  }

  // Banner 直接挂在根 column 内,在 React reconcile 里属于稳定子树不会重 mount。
  // (曾经试过包 <Static>,Ink 在嵌套 Box children 渲染时可能不输出 banner,改回直接挂。)
  const banner = !showBanner
    ? null
    : pickBanner(termWidth, { version: VERSION, model: llm.model, cwd: shortCwd(cwd) });

  // 配对 tool_use ↔ tool_result:AssistantMessage 把 result 内联渲染在 call 下方(树形);
  // 顶层 history loop 跳过已被内联的 ToolMessage 避免重复。
  // 注意:tool message 在 batch 模式下也算"已内联"(由 BatchedToolBlock 接管显示),
  //      所以 inlinedIds 在下面 useMemo 里建立后,batch grouping 与 render 都依赖它。
  const { resultsByCallId, inlinedIds } = useMemo(() => {
    const byId = new Map<string, ToolMessage>();
    const used = new Set<string>();
    for (const m of state.history) {
      if (m.role === "tool" && m.toolUseId) byId.set(m.toolUseId, m);
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "tool_use") used.add(p.id);
        }
      }
    }
    return { resultsByCallId: byId, inlinedIds: used };
  }, [state.history]);

  // Batch 聚合 + TodoWrite 去重:
  // 1) 连续 "只含 tool_use(且非 TodoWrite)" 的 assistant message 合并为 BatchedToolBlock
  //    (muse 的 agent 串行 tool loop——每个工具单独一条 assistant message,散开体验差)
  // 2) TodoWrite 是 in-place 状态更新语义:history 里 N 次 TodoWrite 只渲染最后一次的 → Todos,
  //    前面的 TodoWrite-only message 全部跳过(避免多个 → Todos 块刷屏)
  // maxSrcIdx:group 涉及的 history index 上界,用于 Static 切分(< stableUntilIdx → 进 Static)
  type RenderGroup =
    | { kind: "msg"; key: string; msg: Message; maxSrcIdx: number }
    | { kind: "batch"; key: string; uses: BatchedToolUse[]; maxSrcIdx: number }
    // banner 作为 Static 第一项,跟历史一起被 hoist 到 stdout 顶部。
    // 否则 banner 在 Static 节点之前的 dynamic 区域,Ink 5 在 Static commit 时
    // 会把 Static 内容 hoist 到 banner 之上,视觉上 banner 跑到历史中间。
    | { kind: "banner"; key: string; maxSrcIdx: number }
    // 每个 turn 末尾的灰色摘要行(`✶ Churned for Xm Ys`),来自 state.turnEnds
    | { kind: "churned"; key: string; durationMs: number; maxSrcIdx: number };
  // 反扫找最后一次 TodoWrite 的 part id —— part 级去重的锚点(grouping + MessageView 共用)
  const latestTodoWritePartId = useMemo(() => {
    for (let i = state.history.length - 1; i >= 0; i--) {
      const m = state.history[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        // 一条 message 里可能有多个 TodoWrite,取最后一个
        for (let j = m.content.length - 1; j >= 0; j--) {
          const p = m.content[j];
          if (p.type === "tool_use" && p.name === "TodoWrite") return p.id;
        }
      }
    }
    return undefined;
  }, [state.history]);

  // sticky TodoList(底部固定):扫 history[todosSinceTurnIdx..] 之间最新一次 TodoWrite 的 args
  // 历史区 TodoWrite 不再渲染(AssistantMessage 跳过),全部交给底部 sticky 显示
  const stickyTodos = useMemo(() => {
    for (let i = state.history.length - 1; i >= state.todosSinceTurnIdx; i--) {
      const m = state.history[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (let j = m.content.length - 1; j >= 0; j--) {
          const p = m.content[j];
          if (p.type === "tool_use" && p.name === "TodoWrite") {
            return { args: p.args, key: p.id };
          }
        }
      }
    }
    return null;
  }, [state.history, state.todosSinceTurnIdx]);

  const renderGroups = useMemo(() => {
    // 反扫找最后一次出现 TodoWrite 的 assistant message index
    let lastTodoWriteIdx = -1;
    for (let i = state.history.length - 1; i >= 0; i--) {
      const m = state.history[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        if (m.content.some((p) => p.type === "tool_use" && p.name === "TodoWrite")) {
          lastTodoWriteIdx = i;
          break;
        }
      }
    }
    const groups: RenderGroup[] = [];
    let pending: Array<{ part: ToolUsePart; result?: ToolMessage; srcIndex: number; srcMsg: Message }> = [];
    const flush = () => {
      if (pending.length === 0) return;
      const maxSrc = pending[pending.length - 1].srcIndex;
      if (pending.length === 1) {
        groups.push({ kind: "msg", key: `msg-${pending[0].srcIndex}`, msg: pending[0].srcMsg, maxSrcIdx: maxSrc });
      } else {
        groups.push({
          kind: "batch",
          key: `batch-${pending[0].srcIndex}-${maxSrc}`,
          uses: pending.map((p) => ({ part: p.part, result: p.result })),
          maxSrcIdx: maxSrc,
        });
      }
      pending = [];
    };
    for (let i = 0; i < state.history.length; i++) {
      const msg = state.history[i];
      if (msg.role === "tool" && msg.toolUseId && inlinedIds.has(msg.toolUseId)) continue;
      // 跳过所有 TodoWrite-only assistant message:TodoWrite 现在全部交给底部 sticky TodoList
      // 渲染,历史区不再显示(固定底部体验)
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const isTodoWriteOnly =
          msg.content.length > 0 &&
          msg.content.every((p) => p.type === "tool_use" && p.name === "TodoWrite");
        if (isTodoWriteOnly) {
          flush();
          continue;
        }
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // 只对"纯读 / 无副作用"工具做 message-level batch 聚合:Read/Glob/Grep/MemoryRead
        // Edit/Write/Bash/WebFetch/AskUserQuestion/TodoWrite 等有 side effect 的工具
        // 必须独立显示(diff / 输出 / 副作用确认是用户必看的产物),不能进 batch 折叠。
        const onlyBatchable =
          msg.content.length > 0 &&
          msg.content.every((p) => p.type === "tool_use" && BATCHABLE_TOOLS.has(p.name));
        if (onlyBatchable) {
          for (const p of msg.content) {
            if (p.type === "tool_use") {
              pending.push({ part: p, result: resultsByCallId.get(p.id), srcIndex: i, srcMsg: msg });
            }
          }
          continue;
        }
      }
      flush();
      groups.push({ kind: "msg", key: `msg-${i}`, msg, maxSrcIdx: i });
    }
    flush();
    // 把 turnEnds 转 churned group 插入到对应 history 位置之后:
    // turnEnd.atHistoryLen = N → 渲染在 maxSrcIdx === N-1 的 group 之后
    if (state.turnEnds.length > 0) {
      const merged: RenderGroup[] = [];
      let teIdx = 0;
      for (const g of groups) {
        merged.push(g);
        // 检查后续 turnEnds 是否应该插在该 group 之后
        while (
          teIdx < state.turnEnds.length &&
          state.turnEnds[teIdx].atHistoryLen <= g.maxSrcIdx + 1
        ) {
          const te = state.turnEnds[teIdx];
          merged.push({
            kind: "churned",
            key: `churned-${te.atHistoryLen}-${teIdx}`,
            durationMs: te.durationMs,
            maxSrcIdx: g.maxSrcIdx,
          });
          teIdx++;
        }
      }
      // 剩余 turnEnds(超出当前 history 范围,理论上不会发生)
      while (teIdx < state.turnEnds.length) {
        const te = state.turnEnds[teIdx];
        merged.push({
          kind: "churned",
          key: `churned-${te.atHistoryLen}-${teIdx}`,
          durationMs: te.durationMs,
          maxSrcIdx: state.history.length - 1,
        });
        teIdx++;
      }
      return merged;
    }
    return groups;
  }, [state.history, resultsByCallId, inlinedIds, state.turnEnds]);

  // 按 stableUntilIdx 切分 renderGroups:稳定 groups 走 Static,不再参与重画;动态 groups 走普通渲染。
  // 这是修复"工具快速完成时全 history 重绘 → 闪屏"的关键(详见 实现日志)。
  // **banner 也走 Static**(prepend 第一项),否则 Ink 5 会把后续增量 commit 的 Static 内容
  // hoist 到 banner 之上,视觉上"banner 跑到中间"(实现日志 2026-06-07 banner-static 一节)。
  const { staticGroups, dynamicGroups } = useMemo(() => {
    const cutoff = state.stableUntilIdx;
    const staticG: typeof renderGroups = [];
    const dynamicG: typeof renderGroups = [];
    if (showBanner) {
      // maxSrcIdx=-1 表示永远落在 cutoff 之前 → 始终归 Static
      staticG.push({ kind: "banner", key: "banner-static", maxSrcIdx: -1 });
    }
    for (const g of renderGroups) {
      if (g.maxSrcIdx < cutoff) staticG.push(g);
      else dynamicG.push(g);
    }
    return { staticGroups: staticG, dynamicGroups: dynamicG };
  }, [renderGroups, state.stableUntilIdx, showBanner]);

  return (
    <Box flexDirection="column">
      {/* 稳定历史 + banner(若启用)一起走 Static:Ink 一次 emit 到 stdout,后续 state 变化
          不再 reconcile/repaint 这些行 → 消除闪屏 + 防 banner 被 Static commit hoist 推到中间。 */}
      <Static items={staticGroups}>
        {(g) =>
          g.kind === "banner" ? (
            <React.Fragment key={g.key}>{banner}</React.Fragment>
          ) : g.kind === "batch" ? (
            <BatchedToolBlock key={g.key} uses={g.uses} />
          ) : g.kind === "churned" ? (
            <ChurnedLine key={g.key} durationMs={g.durationMs} />
          ) : (
            <MessageView
              key={g.key}
              message={g.msg}
              resultsByCallId={resultsByCallId}
              latestTodoWritePartId={latestTodoWritePartId}
            />
          )
        }
      </Static>
      <Box flexDirection="column" marginTop={1}>
        {dynamicGroups.map((g) => {
          // banner 永远 maxSrcIdx=-1 → 始终在 staticGroups,不会出现在 dynamic;TS narrowing 用
          if (g.kind === "banner") return null;
          if (g.kind === "batch") {
            return <BatchedToolBlock key={g.key} uses={g.uses} lastStartedToolId={state.lastStartedToolId} />;
          }
          if (g.kind === "churned") {
            return <ChurnedLine key={g.key} durationMs={g.durationMs} />;
          }
          return (
            <MessageView
              key={g.key}
              message={g.msg}
              resultsByCallId={resultsByCallId}
              latestTodoWritePartId={latestTodoWritePartId}
            />
          );
        })}
        {state.streamingText && (
          <Box flexDirection="row" marginTop={1}>
            <Text color="cyan">{DOT} </Text>
            <Box flexDirection="column" flexGrow={1}>
              {/* 流式 markdown 渲染:已闭合 block(段/代码块/list)实时渲染成 ANSI
                  样式;未闭合段保留纯文本。Block 级缓存(React.memo + useMemo)
                  让闭合后的旧 block 不重 parse、不重 render — Ink 看到同样的 Text
                  child 也会减少 erase,显著降低长输出的闪屏(业界同样思路)。 */}
              <StreamingMarkdown text={state.streamingText} />
            </Box>
          </Box>
        )}
      </Box>
      {pending && (
        <PermissionPrompt
          request={{
            ...pending,
            resolve: (decision) => {
              pending.resolve(decision);
              setPending(null);
            },
          }}
        />
      )}
      {picker && (
        <ModelSelector
          request={{
            ...picker,
            resolve: (m) => {
              picker.resolve(m);
              setPicker(null);
            },
          }}
        />
      )}
      {sessionPicker && (
        <SessionSelector
          request={{
            ...sessionPicker,
            resolve: (s) => {
              sessionPicker.resolve(s);
              setSessionPicker(null);
            },
          }}
        />
      )}
      {questionPicker && (
        <QuestionPicker
          request={{
            questions: questionPicker.questions,
            resolve: (responses) => {
              questionPicker.resolve(responses);
              setQuestionPicker(null);
            },
          }}
        />
      )}
      {btwRequest && (
        <BtwOverlay
          request={{
            ...btwRequest,
            resolve: () => {
              btwRequest.resolve();
              setBtwRequest(null);
            },
          }}
          llm={llm}
        />
      )}
      {/* Sticky TodoList:固定在输入框上方(状态行之上),跨工具调用持续可见。
          每次 user_submit 时 todosSinceTurnIdx 重置 → 旧 turn 的 todos 立即消失。
          turn 内 LLM 调 TodoWrite 后这里实时更新;turn 结束(全 completed)仍显示
          到下次用户输入。 */}
      {stickyTodos && (
        <TodoList
          key={stickyTodos.key}
          todos={extractTodos(stickyTodos.args)}
          listTitle={extractListTitle(stickyTodos.args)}
        />
      )}
      {state.status !== "idle" && (
        <StatusLine
          startTime={state.turnStartTime}
          firstTextTime={state.turnFirstTextTime}
          inputTokens={state.turnInputTokens}
          runningTool={state.runningTool}
          lang={lang}
        />
      )}
      {progress && <ProgressBanner state={progress} />}
      {state.stoppedNote && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>{state.stoppedNote}</Text>
        </Box>
      )}
      {inputVisible && (
        <Box flexDirection="column">
          {guidanceQueue.length > 0 && (() => {
            // 引导框 #404040 灰底(输入框 #1c1c1c,亮度差 36),
            // 左 4 cells marginLeft 缩进 + 右侧总宽留 4 cells 空 → 左右两端都比输入框短。
            // 固定宽度(不再跟内容长度变);内容超过宽度截 70 字符 + "…"。
            const INDENT = 4;
            const RIGHT_PAD = 4;
            const innerWidth = Math.max(20, termWidth - 1 - INDENT - RIGHT_PAD);
            return (
              <Box flexDirection="column" marginTop={1} marginLeft={INDENT}>
                {guidanceQueue.map((q, i) => {
                  const preview = previewUserContent(q);
                  const shown = preview.length > 70 ? preview.slice(0, 70) + "…" : preview;
                  const text = ` ↳ 引导  ${shown}`;
                  // stringWidth 算上 CJK 双宽;pad 用空格补到 innerWidth cells
                  const padCells = Math.max(1, innerWidth - stringWidth(text));
                  return (
                    <Box key={i} flexDirection="row">
                      <Text backgroundColor="#404040">{text + " ".repeat(padCells)}</Text>
                    </Box>
                  );
                })}
              </Box>
            );
          })()}
          {/* 有 guidance 时输入框贴紧;无 guidance 时回到 marginTop=1 */}
          <Box marginTop={guidanceQueue.length > 0 ? 0 : 1} flexDirection="column">
            <Text backgroundColor="#1c1c1c">
              {" ".repeat(Math.max(1, termWidth - 1))}
            </Text>
            <Box flexDirection="row">
              <Text backgroundColor="#1c1c1c" color="gray" bold>
                {" › "}
              </Text>
              <BgTextInput
                key={inputRemountKey}
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                width={Math.max(10, termWidth - 4)}
                backgroundColor="#1c1c1c"
                isActive={acceptingInput}
                onPaste={handlePaste}
                onPasteImage={handlePasteImage}
                placeholder={inputPlaceholder}
              />
            </Box>
            <Text backgroundColor="#1c1c1c">
              {" ".repeat(Math.max(1, termWidth - 1))}
            </Text>
          </Box>
          {autocomplete && autocomplete.matches.length > 0 && (
            <SlashAutocomplete matches={autocomplete.matches} index={autocompleteIndex} />
          )}
          {atQuery !== null && atMatches.length > 0 && (
            <AtFileAutocomplete matches={atMatches} index={atIndex} />
          )}
        </Box>
      )}
      <Box flexDirection="column">
        <FooterStatus
          sessionId={session.meta.id}
          model={llm.model}
          contextWindow={llm.capabilities.maxContextWindow}
          lastInputTokens={state.turnInputTokens}
          sessionInputTokens={state.inputTokens}
          sessionOutputTokens={state.outputTokens}
          termWidth={termWidth}
        />
        <PermissionModeBar mode={mode} compact={termWidth < 60} />
        {escHint && (
          <Box flexDirection="row">
            <Text dimColor>{escHint}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function extractUserInputs(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    // 跳过 /compact 注入的 "[Previous conversation summary]" 等系统消息
    if (text.startsWith("[Previous conversation summary]")) continue;
    if (text.trim()) out.push(text);
  }
  return out;
}

/** 队列 / 历史预览:从 string 或 ContentPart[] 抽一段可读字符。 */
/**
 * 判断错误是否是用户主动 abort 的(Esc/Ctrl+C)。覆盖 Vercel SDK "This operation was aborted"
 * 这种 name 不是 AbortError 但 message 带关键字的 case。
 */
/**
 * 把 LLM / provider 抛出来的错误转成给用户看的灰字提示。
 *  - "unavailable tool 'X'" 这类是切换 mode 后历史里仍有禁用工具的 server 拒绝;
 *    告诉用户"模型试图调用 X(当前模式不允许)",避免红字 [error] 跟模型回答混在一起
 *  - 其他错误保留原文(英文一句),前缀 ⚠
 */
function formatErrorForUser(message: string): string {
  const m = message.trim();
  // server 端拒绝:`...unavailable tool 'Edit'...`
  const unavail = m.match(/unavailable tool ['"]?([A-Za-z_][\w]*)['"]?/i);
  if (unavail) {
    return `⚠ 模型试图调用 ${unavail[1]},当前模式不允许;请切换模式或换种问法`;
  }
  // 通用网络 / 超时归类
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return `⚠ 请求超时,请重试`;
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(m)) return `⚠ 网络无法连接 provider`;
  if (/rate limit|429/i.test(m)) return `⚠ 触发 provider 限流,稍候重试`;
  return `⚠ ${m}`;
}

function isAbortLike(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const code = (err as Error & { code?: string }).code;
    if (code === "ABORT_ERR" || code === "ECANCELED") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("aborted") || msg.includes("cancelled") || msg.includes("canceled")) return true;
  }
  return false;
}

/** 单个 turn 结尾的灰色摘要行,`✶ Churned for Xm Ys` 风格。 */
function ChurnedLine({ durationMs }: { durationMs: number }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{`✶ Churned for ${formatChurnedDuration(durationMs)}`}</Text>
    </Box>
  );
}

function formatChurnedDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function previewUserContent(input: string | ContentPart[]): string {
  if (typeof input === "string") return input;
  const text = input
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  const fileCount = input.filter((p) => p.type === "file").length;
  const imageCount = input.filter((p) => p.type === "image").length;
  const tags: string[] = [];
  if (fileCount > 0) tags.push(`📎 ${fileCount}`);
  if (imageCount > 0) tags.push(`🖼 ${imageCount}`);
  return tags.length > 0 ? `${text} (${tags.join(", ")})` : text;
}

function shortCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/**
 * 把当前选中的 model id 写回 ~/.muse/settings.json llm.model。
 *
 * 这是 muse 第一次"写配置"。策略：read-modify-write 整文件，pretty-print 2 空格。
 * 不强制 chmod —— settings.json 不放明文 key，敏感数据在 settings.local.json。
 */
async function persistActiveModel(modelId: string): Promise<void> {
  const path = join(homedir(), ".muse", "settings.json");
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const llm = (current.llm as Record<string, unknown> | undefined) ?? {};
  const next = { ...current, llm: { ...llm, model: modelId } };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
}
