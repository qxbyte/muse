/**
 * Ink 根组件：banner + 消息历史 + 输入框 + 流式响应 + slash 命令调度。
 *
 * SlashActions 在这里注入。LLM client / settings / modelsRegistry 都是 mutable state，
 * /models /config reload 通过 setLLM / setSettings / setModelsRegistry 触发 Agent 重建，
 * messages 通过 messagesRef 跨重建保留。
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pickBanner } from "./components/StartupBanner.js";
import { MessageView } from "./components/MessageView.js";
import { PermissionPrompt, type PermissionRequest } from "./components/PermissionPrompt.js";
import { ModelSelector, type ModelPickerRequest } from "./components/ModelSelector.js";
import { SessionSelector, type SessionPickerRequest } from "./components/SessionSelector.js";
import { SlashAutocomplete } from "./components/SlashAutocomplete.js";
import { PermissionModeBar } from "./components/PermissionModeBar.js";
import { ProgressBanner, type ProgressState } from "./components/ProgressBanner.js";
import type { LLMClient } from "./llm/types.js";
import { createLLMClient, createLLMClientFromModelEntry, setActiveModelEnv } from "./llm/client.js";
import type { ToolRegistry } from "./tools/registry.js";
import { PermissionGate, type PermissionMode, type PermissionDecision } from "./permission/index.js";
import { Session, type SessionSummary } from "./session/jsonl.js";
import { Agent } from "./loop/agent.js";
import { buildSystemPrompt } from "./loop/system-prompt.js";
import { loadMemoryIndex } from "./loop/memory.js";
import { loadSettings } from "./config/index.js";
import { loadModelsRegistry, findEntry, type ModelEntry, type ModelsRegistry } from "./config/models.js";
import type { Message, TokenUsage } from "./types/index.js";
import type { Settings } from "./config/types.js";
import {
  BUILTIN_SLASH_COMMANDS,
  SlashRegistry,
  parseSlash,
  type SlashActions,
  type SlashCommand,
  type SlashCommandResult,
} from "./slash/index.js";

export interface AppProps {
  llm: LLMClient;
  tools: ToolRegistry;
  permissions: PermissionGate;
  session: Session;
  settings: Settings;
  settingsSources: string[];
  modelsRegistry?: ModelsRegistry;
  modelsSources: string[];
  cwd: string;
  lang: "en" | "zh-CN";
  showBanner: boolean;
  initialMessages?: Message[];
}

interface UIState {
  history: Message[];
  streamingText: string;
  status: "idle" | "streaming" | "tool";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

type UIAction =
  | { type: "user_submit" }
  | { type: "history_set"; messages: Message[] }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_reset" }
  | { type: "set_status"; status: UIState["status"] }
  | { type: "add_usage"; usage: TokenUsage };

function reducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "user_submit":
      return { ...state, streamingText: "", status: "streaming" };
    case "history_set":
      return { ...state, history: action.messages };
    case "stream_delta":
      return { ...state, streamingText: state.streamingText + action.delta };
    case "stream_reset":
      return { ...state, streamingText: "" };
    case "set_status":
      return { ...state, status: action.status };
    case "add_usage":
      return {
        ...state,
        inputTokens: state.inputTokens + action.usage.inputTokens,
        outputTokens: state.outputTokens + action.usage.outputTokens,
        totalTokens: state.totalTokens + action.usage.totalTokens,
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
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
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
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [picker, setPicker] = useState<ModelPickerRequest | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerRequest | null>(null);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const agentRef = useRef<Agent | null>(null);

  // 输入历史：纯用户输入（不含 slash 命令），最旧 → 最新 push 到末尾
  // historyIndex: -1=未导航；0=最新；len-1=最旧
  const inputHistoryRef = useRef<string[]>(extractUserInputs(initialMessages ?? []));
  const historyIndexRef = useRef<number>(-1);
  const savedDraftRef = useRef<string>("");

  const slash = useMemo(() => {
    const r = new SlashRegistry();
    r.registerAll(BUILTIN_SLASH_COMMANDS);
    return r;
  }, []);

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

  useEffect(() => {
    const systemPrompt = buildSystemPrompt({
      cwd,
      model: llm.model,
      provider: llm.providerName,
      lang,
      toolNames: tools.list().map((t) => t.name),
      memoryIndex,
    });

    const agent = new Agent({
      llm,
      tools,
      permissions,
      session,
      cwd,
      systemPrompt,
      events: {
        onText: (delta) => dispatch({ type: "stream_delta", delta }),
        onToolCallStart: () => dispatch({ type: "set_status", status: "tool" }),
        onUsage: (usage: TokenUsage) => dispatch({ type: "add_usage", usage }),
        onTurnEnd: () => {
          const msgs = [...agent.getMessages()];
          messagesRef.current = msgs;
          dispatch({ type: "history_set", messages: msgs });
          dispatch({ type: "stream_reset" });
          dispatch({ type: "set_status", status: "idle" });
        },
        onError: (err) => {
          dispatch({ type: "stream_delta", delta: `\n[error] ${err.message}\n` });
          dispatch({ type: "set_status", status: "idle" });
        },
        onPermissionRequest: (toolName, args, summary) =>
          new Promise<PermissionDecision>((resolve) => {
            setPending({ toolName, args, summary, resolve });
          }),
      },
    });
    agent.setMessages(messagesRef.current);
    agentRef.current = agent;
  }, [llm, tools, permissions, session, cwd, lang, memoryIndex]);

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

      // autocomplete 关闭时：↑/↓ 翻输入历史
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
    { isActive: state.status === "idle" && !pending && !picker && !sessionPicker },
  );

  const acceptingInput =
    state.status === "idle" && pending === null && picker === null && sessionPicker === null;

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
      const trimmed = value.trim();
      if (!trimmed) return;

      // autocomplete 开 + 有候选 + 用户没在精确命名 → 补全到 input，不提交
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

      const parsed = parseSlash(trimmed);
      if (parsed) {
        const cmd = slash.get(parsed.name);
        commitInput("");
        if (!cmd) {
          appendAssistantText(`Unknown command: /${parsed.name}. Try /help.`);
          return;
        }
        try {
          const result = await cmd.execute({
            args: parsed.args,
            cwd,
            llm,
            session,
            settings,
            settingsSources,
            modelsRegistry,
            // 用 ref 而非 state.history：命令体可能在 await 期间调 setMessages
            // 改变 messages（如 /resume / /compact），后续 display 必须基于最新值
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
          appendAssistantText(`[error] /${parsed.name}: ${msg}`);
        }
        return;
      }

      commitInput("");
      // 推入历史（去重相邻重复），重置游标
      const hist = inputHistoryRef.current;
      if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
      if (hist.length > 200) hist.shift();
      historyIndexRef.current = -1;
      savedDraftRef.current = "";

      dispatch({ type: "user_submit" });
      try {
        await agentRef.current?.runTurn(trimmed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "stream_delta", delta: `\n[error] ${msg}\n` });
        dispatch({ type: "set_status", status: "idle" });
      }
    },
    [slash, cwd, llm, session, settings, settingsSources, modelsRegistry, state.inputTokens, state.outputTokens, state.totalTokens, actions, autocomplete, autocompleteIndex],
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
      exit();
      return;
    }
    if (result.display !== undefined) {
      appendAssistantText(result.display);
    }
  }

  const banner = !showBanner
    ? null
    : pickBanner(termWidth, { version: "0.1.0", model: llm.model, cwd: shortCwd(cwd) });

  return (
    <Box flexDirection="column">
      {banner}
      <Box flexDirection="column" marginTop={1}>
        {state.history.map((msg, i) => (
          <MessageView key={i} message={msg} />
        ))}
        {state.streamingText && (
          <Box marginTop={1}>
            <Text>{state.streamingText}</Text>
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
      {acceptingInput && (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Text color="cyan">{"> "}</Text>
            <TextInput key={inputRemountKey} value={input} onChange={setInput} onSubmit={handleSubmit} />
          </Box>
          {autocomplete && autocomplete.matches.length > 0 && (
            <SlashAutocomplete matches={autocomplete.matches} index={autocompleteIndex} />
          )}
        </Box>
      )}
      {state.status === "streaming" && (
        <Box marginTop={1}>
          <Text dimColor>... (streaming)</Text>
        </Box>
      )}
      {state.status === "tool" && (
        <Box marginTop={1}>
          <Text dimColor>... (running tool)</Text>
        </Box>
      )}
      {progress && <ProgressBanner state={progress} />}
      <Box marginTop={1}>
        <PermissionModeBar mode={mode} compact={termWidth < 60} />
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
