/**
 * 内置 slash 命令：/help /clear /compact /model /config /mcp /cost /resume /exit
 *
 * 设计文档：muse-design.md §7.2 表中 9 条全部覆盖。
 *
 * 设计原则：命令体只编排（解析参数 → 调 actions / 领域模块 → 构造 display）。
 * 真正的业务（压缩、列 session、查 MCP）在各自的领域模块里。
 */

import type { SlashCommand, SlashCommandContext } from "./types.js";
import { SKILL } from "./skill.js";
import { MCP } from "./mcp.js";
import { estimateCostUSD, formatUSD, lookupPricing } from "../llm/pricing.js";
import { redactApiKey } from "../log/index.js";
import { compactMessages } from "../loop/context.js";
import { Session } from "../session/jsonl.js";
import { loadModelsRegistry, type LoadError } from "../config/models.js";
import { shortPath, formatList, parseArgs, formatTime } from "./_format.js";
import { MODE_CYCLE, MODE_LABEL, type PermissionMode } from "../permission/index.js";
import {
  listMemories,
  readMemory,
  deleteMemory,
  setMemoryTrust,
  promoteScopeToUser,
  writeMemory,
  TRUST_LEVELS,
  SCOPES,
  type TrustLevel,
  type Scope,
  type MemoryType,
} from "../loop/memory.js";
import { buildMemoryIndex, queryMemoryIndex } from "../loop/memory-index.js";
import { EMBEDDING_PRESETS, listPresetNames, createAndProbeProvider } from "../loop/embedding/index.js";
import { memoryDir, globalMemoryDir } from "../loop/memory.js";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { LLMClient } from "../llm/types.js";

// ----- /help -----

/** /help 命令分类(命令名顺序即输出顺序)。未列入此处的新命令会进 "Other"。 */
const HELP_CATEGORIES: Array<{ title: string; names: string[] }> = [
  { title: "Chat & turn control", names: ["help", "clear", "compact", "resume", "cost", "btw"] },
  { title: "Memory", names: ["memory", "remember"] },
  { title: "Extensions", names: ["skill", "mcp"] },
  { title: "Configuration", names: ["model", "config", "mode"] },
  { title: "Exit", names: ["exit"] },
];

const KEY_BINDINGS = [
  "Key bindings:",
  "  Enter         submit",
  "  \\ + Enter     newline (multiline input)",
  "  Esc           cancel current LLM / tool, or clear guidance queue",
  "  Esc Esc       rewind: pull last user message back into input, drop everything after",
  "  Shift+Tab     cycle permission mode (default / acceptEdits / plan / bypassPermissions)",
  "  Ctrl+C        exit muse (or cancel running tool first)",
  "  ↑ / ↓         history navigation",
  "  Cmd/Ctrl+V    paste (text or clipboard image)",
  "  @<path>       file reference autocomplete",
  "  /             slash command autocomplete",
].join("\n");

const HELP: SlashCommand = {
  name: "help",
  description: "show available slash commands + key bindings",
  execute(ctx) {
    const cmds = ctx.listCommands();
    const byName = new Map(cmds.map((c) => [c.name, c]));
    const maxHeadLen = Math.max(...cmds.map((c) => headOf(c).length));

    const lines: string[] = ["Built-in commands:"];
    const seen = new Set<string>();

    for (const cat of HELP_CATEGORIES) {
      const catCmds = cat.names.map((n) => byName.get(n)).filter((c): c is SlashCommand => !!c);
      if (catCmds.length === 0) continue;
      lines.push("");
      lines.push(`  ${cat.title}:`);
      for (const cmd of catCmds) {
        seen.add(cmd.name);
        const head = headOf(cmd);
        const aliasNote = cmd.aliases?.length
          ? `  (alias: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
          : "";
        lines.push(`    /${head.padEnd(maxHeadLen)}   ${cmd.description}${aliasNote}`);
      }
    }

    // 漏网之鱼(防止新命令未分类时不显示)
    const uncat = cmds.filter((c) => !seen.has(c.name));
    if (uncat.length > 0) {
      lines.push("");
      lines.push(`  Other:`);
      for (const cmd of uncat) {
        const head = headOf(cmd);
        lines.push(`    /${head.padEnd(maxHeadLen)}   ${cmd.description}`);
      }
    }

    lines.push("", KEY_BINDINGS);
    return { display: lines.join("\n") };
  },
};

function headOf(c: SlashCommand): string {
  return c.argsHint ? `${c.name} ${c.argsHint}` : c.name;
}

// ----- /clear -----

const CLEAR: SlashCommand = {
  name: "clear",
  description: "clear conversation history",
  execute(ctx) {
    ctx.actions.setMessages([]);
    return { display: "(history cleared)" };
  },
};

// ----- /exit -----

const FAREWELLS = [
  "Goodbye",
  "Bye",
  "Bye, see ya",
  "See you later",
  "Take care",
  "Catch you later",
  "Adios",
  "Ciao",
  "Later",
  "Until next time",
] as const;

function randomFarewell(): string {
  return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)];
}

const EXIT: SlashCommand = {
  name: "exit",
  description: "exit Muse",
  execute() {
    // display + exit:app.tsx 在 exit 分支把 display 当 assistant message append,
    // 延后 exit() 让 Ink commit 一帧含告别语的 frame 后再 unmount。
    // Ink unmount 不主动清屏 — 最后一帧留在终端,告别语跟在 assistant 消息后、
    // 输入框之前(视觉与模型回复一致)。
    return { display: randomFarewell(), exit: true };
  },
};

// ----- /cost -----

const COST: SlashCommand = {
  name: "cost",
  description: "show token usage and estimated cost for this session",
  execute(ctx) {
    const { tokens, llm } = ctx;
    const pricing = lookupPricing(llm.providerName, llm.model);
    const lines = [
      `Session cost`,
      `  provider/model:  ${llm.providerName} / ${llm.model}`,
      `  input tokens:    ${tokens.inputTokens.toLocaleString()}`,
      `  output tokens:   ${tokens.outputTokens.toLocaleString()}`,
      `  total tokens:    ${tokens.totalTokens.toLocaleString()}`,
    ];
    if (pricing) {
      const cost = estimateCostUSD(llm.providerName, llm.model, tokens.inputTokens, tokens.outputTokens) ?? 0;
      lines.push(
        `  price (per 1M):  input $${pricing.inputPer1M}  /  output $${pricing.outputPer1M}`,
        `  estimated cost:  ${formatUSD(cost)}`,
      );
    } else {
      lines.push(`  estimated cost:  (no pricing data for ${llm.providerName}/${llm.model})`);
    }
    return { display: lines.join("\n") };
  },
};

// ----- /compact -----

const COMPACT_TIPS = [
  "Shift+Tab cycles permission modes (default / acceptEdits / plan / bypass)",
  "/mode plan drafts changes without executing them",
  "/cost shows token usage and estimated spend",
  "/resume picks up a previous session in this directory",
  "muse --continue resumes the last session on startup",
  "MemoryWrite saves persistent knowledge across sessions",
  "TodoWrite keeps the model honest on multi-step tasks",
  "Pipe to muse: cat bug.log | muse \"explain this\"",
  "Ctrl+C exits immediately; Esc rejects a pending tool",
];

// 经验值：muse-design §5.3 提的 200-400 词摘要约 1.2-1.8k 字符
const COMPACT_ESTIMATED_CHARS = 1800;

const COMPACT: SlashCommand = {
  name: "compact",
  description: "summarize older messages to free up context space",
  argsHint: "[--keep N]",
  async execute(ctx) {
    if (ctx.history.length === 0) return { display: "(empty history; nothing to compact)" };
    const { flags } = parseArgs(ctx.args);
    const keepRecent = typeof flags.keep === "string" ? Math.max(1, parseInt(flags.keep, 10)) : 4;
    if (Number.isNaN(keepRecent)) return { display: `Invalid --keep value: ${flags.keep}` };

    // ProgressBanner 每 tick 调 getPercent；用闭包持有的 ref 让 banner 看到最新值
    const progressRef = { chars: 0 };
    ctx.actions.showProgress({
      title: "Compacting conversation",
      tips: COMPACT_TIPS,
      getPercent: () => (progressRef.chars / COMPACT_ESTIMATED_CHARS) * 100,
    });

    try {
      const result = await compactMessages(ctx.history, {
        llm: ctx.llm,
        keepRecent,
        hooks: ctx.settings.hooks,
        cwd: ctx.cwd,                  // I-5:触发 facts → memory promote
        onProgress: (chars) => {
          progressRef.chars = chars;
        },
      });
      if (result.noop) {
        return { display: `(history has ${result.originalCount} messages; not enough to compact with --keep ${keepRecent})` };
      }
      ctx.actions.setMessages(result.newMessages);
      const preview = result.summary.length > 240 ? result.summary.slice(0, 240) + "…" : result.summary;
      const promoteNote = renderPromotedFactsNote(result.promotedFacts);
      return {
        display:
          `Compacted ${result.originalCount} → ${result.newCount} messages ` +
          `(kept last ${keepRecent}).\n\nSummary:\n${preview}${promoteNote}`,
      };
    } finally {
      ctx.actions.hideProgress();
    }
  },
};

function renderPromotedFactsNote(facts?: import("../loop/context.js").PromotedFact[]): string {
  if (!facts || facts.length === 0) return "";
  const saved = facts.filter((f) => f.status === "saved");
  const skipped = facts.filter((f) => f.status === "skipped");
  const blocked = facts.filter((f) => f.status === "blocked");
  const failed = facts.filter((f) => f.status === "failed");
  const lines: string[] = ["\n\nPromoted to long-term memory:"];
  for (const f of saved) lines.push(`  ✓ [${f.type}] ${f.name} — ${f.description}`);
  for (const f of skipped) lines.push(`  · [${f.type}] ${f.name} (skipped: ${f.reason ?? "already exists"})`);
  for (const f of blocked) lines.push(`  ⊘ [${f.type}] ${f.name} (blocked by MemoryPromote hook${f.reason ? `: ${f.reason}` : ""})`);
  for (const f of failed) lines.push(`  ✗ [${f.type}] ${f.name} (failed${f.reason ? `: ${f.reason}` : ""})`);
  return lines.join("\n");
}

// ----- /model -----

const MODELS: SlashCommand = {
  name: "model",
  description: "pick a model from ~/.muse/models.local.json (↑↓ to navigate)",
  async execute(ctx) {
    // ctx 没拿到 registry 时同步重读一次：可能 muse 启动后用户改了文件
    let registry = ctx.modelsRegistry;
    let errors: LoadError[] = [];
    if (!registry) {
      const r = await loadModelsRegistry();
      registry = r.registry;
      errors = r.errors;
    }

    if (!registry) {
      if (errors.length > 0) {
        return { display: renderLoadErrors(errors) };
      }
      return { display: renderEmptyRegistryHint() };
    }

    const visible = registry.models;
    if (visible.length === 0) {
      return {
        display:
          `models.local.json has no models.\n` +
          `Add at least one entry to the "models" array.`,
      };
    }

    const picked = await ctx.actions.pickModel(visible, ctx.llm.model);
    if (!picked) return { display: "(cancelled)" };
    if (picked.id === ctx.llm.model) return { display: `Already on ${picked.id}.` };

    try {
      await ctx.actions.switchModel(picked.id);
      return { display: `Switched to ${picked.id}${picked.vendor ? ` (${picked.vendor})` : ""}.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { display: `Failed to switch: ${msg}` };
    }
  },
};

function renderLoadErrors(errors: LoadError[]): string {
  return [
    `models.local.json was found but failed to load:`,
    ``,
    ...errors.flatMap((e) => [`  ${shortPath(e.path)}`, `    ${e.message}`]),
    ``,
    `Fix the file above, then run /model again (it re-reads on each call).`,
    `Hint: each entry needs "id" and "baseUrl" (or "url"); "apiKey" supports \${ENV_VAR}.`,
  ].join("\n");
}

function renderEmptyRegistryHint(): string {
  return [
    `No models registry found.`,
    `Create ~/.muse/models.local.json with a "models" array. Example:`,
    ``,
    `{`,
    `  "models": [`,
    `    {`,
    `      "id": "<your-model-id>",`,
    `      "vendor": "<vendor-name>",`,
    `      "baseUrl": "https://...",`,
    `      "apiKey": "\${YOUR_API_KEY}",`,
    `      "supportsToolCall": true`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Then run /model again (no restart needed).`,
  ].join("\n");
}

// ----- /config -----

const CONFIG: SlashCommand = {
  name: "config",
  description: "show / reload configuration (API keys redacted)",
  argsHint: "[reload | path]",
  async execute(ctx) {
    const sub = ctx.args.trim();

    if (sub === "reload") {
      try {
        const { sources } = await ctx.actions.reloadSettings();
        return { display: `Reloaded from ${sources.length} sources:\n` + sources.map((s) => `  - ${shortPath(s)}`).join("\n") };
      } catch (err) {
        return { display: `Reload failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    if (sub === "path") {
      return { display: renderConfigPaths(ctx) };
    }

    if (sub && sub !== "show") {
      return { display: `Unknown subcommand: /config ${sub}. Use: /config [show|reload|path]` };
    }

    return { display: renderConfigShow(ctx) };
  },
};

function renderConfigShow(ctx: SlashCommandContext): string {
  const s = ctx.settings;
  const lines = [
    `Effective configuration`,
    `  sources:`,
    ...ctx.settingsSources.map((src) => `    - ${shortPath(src)}`),
    ``,
    `  llm:`,
    `    provider:  ${s.llm?.provider ?? "(unset)"}`,
    `    model:     ${s.llm?.model ?? "(unset)"}`,
  ];
  if (s.llm?.temperature !== undefined) lines.push(`    temperature: ${s.llm.temperature}`);
  if (s.llm?.maxTokens !== undefined) lines.push(`    maxTokens:   ${s.llm.maxTokens}`);

  lines.push(``, `  providers (apiKey redacted):`);
  for (const [name, cfg] of Object.entries(s.providers ?? {})) {
    lines.push(`    ${name}:  apiKey=${redactApiKey(cfg.apiKey)}  baseUrl=${cfg.baseUrl ?? "(default)"}`);
  }

  lines.push(``, `  permissions:`);
  lines.push(`    defaultMode: ${s.permissions?.defaultMode ?? "ask"}`);
  lines.push(`    allow:       ${formatList(s.permissions?.allow)}`);
  lines.push(`    ask:         ${formatList(s.permissions?.ask)}`);
  lines.push(`    deny:        ${formatList(s.permissions?.deny)}`);

  lines.push(``, `  ui:`);
  lines.push(`    lang:        ${s.ui?.lang ?? "(default)"}`);
  lines.push(`    showBanner:  ${s.ui?.showBanner ?? true}`);

  return lines.join("\n");
}

function renderConfigPaths(ctx: SlashCommandContext): string {
  const home = process.env.HOME ?? "~";
  return [
    `Configuration file paths (high to low precedence):`,
    `  1. CLI flags / env (MUSE_PROVIDER, MUSE_MODEL, …)`,
    `  2. ${shortPath(`${ctx.cwd}/.muse/settings.local.json`)}  (project, gitignored)`,
    `  3. ${shortPath(`${ctx.cwd}/.muse/settings.json`)}        (project, committable)`,
    `  4. ${shortPath(`${home}/.muse/settings.json`)}            (global)`,
    `  5. <built-in defaults>`,
    ``,
    `Edit any of the above, then run /config reload (no restart needed).`,
  ].join("\n");
}

// ----- /resume -----

const RESUME: SlashCommand = {
  name: "resume",
  description: "resume a past session (↑↓ to pick, or pass an id-prefix)",
  argsHint: "[session-id-prefix]",
  async execute(ctx) {
    // 带参快捷路径：直接按 id 前缀加载，不弹 selector
    if (ctx.args) {
      let meta;
      try {
        meta = await Session.resolve(ctx.cwd, ctx.args);
      } catch (err) {
        return { display: err instanceof Error ? err.message : String(err) };
      }
      if (!meta) return { display: `No session matches "${ctx.args}".` };
      return loadAndReport(meta, ctx);
    }

    // 无参：列出近 20 条交给 selector
    const list = await Session.listAll(ctx.cwd, 20);
    if (list.length === 0) return { display: "No past sessions in this directory." };

    const picked = await ctx.actions.pickSession(list, ctx.session.meta.id);
    if (!picked) return { display: "(cancelled)" };
    if (picked.id === ctx.session.meta.id) return { display: "Already on this session." };

    return loadAndReport(picked, ctx);
  },
};

async function loadAndReport(
  meta: { id: string; createdAt: string; path: string; cwd: string },
  ctx: import("./types.js").SlashCommandContext,
): Promise<{ display: string }> {
  const { events } = await Session.open(meta);
  const messages = Session.messagesFromEvents(events);
  ctx.actions.setMessages(messages);
  return {
    display: `Resumed session ${meta.id.slice(0, 8)} (${messages.length} messages from ${formatTime(meta.createdAt)}).`,
  };
}

// ----- /mode -----

const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  normal: "default",
  acceptedits: "acceptEdits",
  "accept-edits": "acceptEdits",
  accept: "acceptEdits",
  edits: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
  bypasspermissions: "bypassPermissions",
};

const MODE_CMD: SlashCommand = {
  name: "mode",
  description: "show or switch the permission mode (alternative to Shift+Tab)",
  argsHint: "[default|acceptEdits|plan|bypassPermissions]",
  execute(ctx) {
    const arg = ctx.args.trim().toLowerCase();
    if (!arg) {
      const cur = ctx.actions.getMode();
      const lines = [`Current permission mode: ${cur} — ${MODE_LABEL[cur]}`, ``, `Available modes:`];
      for (const m of MODE_CYCLE) {
        const marker = m === cur ? "●" : " ";
        lines.push(`  ${marker} ${m.padEnd(20)} ${MODE_LABEL[m]}`);
      }
      lines.push(``, `Switch: /mode <name>   or   Shift+Tab to cycle`);
      return { display: lines.join("\n") };
    }
    const target = MODE_ALIASES[arg];
    if (!target) {
      return {
        display: `Unknown mode "${ctx.args.trim()}". Valid: ${MODE_CYCLE.join(" | ")}`,
      };
    }
    if (target === ctx.actions.getMode()) return { display: `Already in ${target} mode.` };
    ctx.actions.setMode(target);
    return { display: `Switched to ${target} — ${MODE_LABEL[target]}` };
  },
};

// ----- /btw -----

const BTW: SlashCommand = {
  name: "btw",
  description: "ask a quick side question (answer in popup, not saved to history)",
  argsHint: "<question>",
  async execute(ctx) {
    const q = ctx.args.trim();
    if (!q) {
      return {
        display:
          `Usage: /btw <question>\n` +
          `  One-shot Q&A using the current conversation as context.\n` +
          `  The Q & A are shown in an overlay and NOT added to history.\n` +
          `  No tools — the model answers from context + its own knowledge.`,
      };
    }
    // askBtw 在浮层关闭时 resolve；display 返回空 → applySlashResult 不会追加任何 assistant 消息
    await ctx.actions.askBtw(q);
    return {};
  },
};

// ----- /memory -----

const MEMORY_HELP = [
  `Usage:`,
  `  /memory                              list all memories (default; both scopes)`,
  `  /memory list [--scope <s>]           list (s = project | user | all)`,
  `  /memory view <name> [--scope <s>]    show full content + frontmatter`,
  `  /memory edit <name> [--scope <s>]    open in $EDITOR; trust auto→verified on save`,
  `  /memory delete <name> [--scope <s>]  remove permanently`,
  `  /memory promote <name>               auto → verified`,
  `  /memory promote-scope <name>         project → user (lift to global scope)`,
  `  /memory trust <name> <level>         set trust (verified | auto;`,
  `                                       trusted reserved for MUSE.md / AGENTS.md)`,
  `  /memory search <query>               vector-based semantic search`,
  `  /memory diff [--scope <s>]           show memories sorted by updated_at (recent first)`,
  `  /memory diagnose                     show embedding status + config + fix tips`,
  ``,
  `Scopes:`,
  `  [project]  per-project memory: ~/.muse/projects/<hash>/memory/`,
  `  [user]     global cross-project memory: ~/.muse/memory/`,
  `  Both are merged at recall time; project ranks higher when scores tie.`,
].join("\n");

/** 解析 --scope=<value> 或 --scope <value> 标志。返回 scope + 剩余 args 列表。 */
function parseScopeFlag(parts: string[]): { scope?: Scope | "all"; rest: string[] } {
  const rest: string[] = [];
  let scope: Scope | "all" | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "--scope" && i + 1 < parts.length) {
      const v = parts[i + 1];
      if (v === "all" || (SCOPES as readonly string[]).includes(v)) {
        scope = v as Scope | "all";
        i++;
        continue;
      }
    } else if (p.startsWith("--scope=")) {
      const v = p.slice("--scope=".length);
      if (v === "all" || (SCOPES as readonly string[]).includes(v)) {
        scope = v as Scope | "all";
        continue;
      }
    }
    rest.push(p);
  }
  return { scope, rest };
}

const MEMORY: SlashCommand = {
  name: "memory",
  description: "manage long-term memory (list / view / delete / promote / promote-scope / trust / search)",
  argsHint: "[list | view <name> | delete <name> | promote <name> | promote-scope <name> | trust <name> <level> | search <query>] [--scope project|user|all]",
  async execute(ctx) {
    const args = ctx.args.trim();
    const allParts = args.length ? args.split(/\s+/) : [];
    const { scope, rest: parts } = parseScopeFlag(allParts);
    const sub = parts[0] ?? "list";
    try {
      switch (sub) {
        case "list":
          return await memoryList(ctx.cwd, scope ?? "all");
        case "view":
          if (!parts[1]) return { display: `Usage: /memory view <name> [--scope project|user]` };
          return await memoryView(ctx.cwd, parts[1], scope === "all" ? undefined : scope);
        case "delete":
        case "rm":
          if (!parts[1]) return { display: `Usage: /memory delete <name> [--scope project|user]` };
          return await memoryDelete(ctx.cwd, parts[1], scope === "all" ? undefined : scope);
        case "promote":
          if (!parts[1]) return { display: `Usage: /memory promote <name>` };
          return await memoryPromote(ctx.cwd, parts[1], scope === "all" ? undefined : scope);
        case "promote-scope":
          if (!parts[1]) return { display: `Usage: /memory promote-scope <name>  (project → user)` };
          return await memoryPromoteScope(ctx.cwd, parts[1]);
        case "trust":
          if (!parts[1] || !parts[2]) return { display: `Usage: /memory trust <name> <verified|auto> [--scope project|user]` };
          return await memoryAssignTrust(ctx.cwd, parts[1], parts[2], scope === "all" ? undefined : scope);
        case "search": {
          const query = parts.slice(1).join(" ");
          if (!query) return { display: `Usage: /memory search <query>` };
          return await memorySearch(ctx.cwd, query);
        }
        case "diff":
          return await memoryDiff(ctx.cwd, scope === "all" ? undefined : scope);
        case "edit":
          if (!parts[1]) return { display: `Usage: /memory edit <name> [--scope project|user]` };
          return await memoryEdit(ctx, parts[1], scope === "all" ? undefined : scope);
        case "diagnose":
        case "doctor":
          return await memoryDiagnose(ctx.cwd, ctx.settings);
        case "help":
          return { display: MEMORY_HELP };
        default:
          return { display: `Unknown subcommand: ${sub}\n\n${MEMORY_HELP}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { display: `Memory operation failed: ${msg}` };
    }
  },
};

async function memoryList(cwd: string, scope: Scope | "all") {
  const list = await listMemories(cwd, { scope });
  if (list.length === 0) {
    const where = scope === "all" ? "either scope" : `scope=${scope}`;
    return { display: `(no memories saved in ${where})\n\n${MEMORY_HELP}` };
  }
  const lines = list.map((m) => {
    const trustTag = `[${m.frontmatter.trust}]`.padEnd(11);
    const scopeTag = `[${m.scope}]`.padEnd(10);
    const typeTag = `(${m.frontmatter.type})`.padEnd(12);
    return `  ${trustTag} ${scopeTag} ${typeTag} ${m.frontmatter.name}  — ${m.frontmatter.description}`;
  });
  const scopeNote = scope === "all" ? "(both scopes merged)" : `(scope=${scope})`;
  return {
    display: `Memories ${scopeNote} — ${list.length} total:\n\n${lines.join("\n")}\n\n${MEMORY_HELP}`,
  };
}

async function memoryView(cwd: string, name: string, scope?: Scope) {
  const file = await readMemory(cwd, name, scope);
  const fm = file.frontmatter;
  return {
    display:
      `${name}  (scope: ${file.scope})\n` +
      `  trust:       ${fm.trust}\n` +
      `  type:        ${fm.type}\n` +
      `  source:      ${fm.source}\n` +
      `  created:     ${fm.created_at}\n` +
      `  updated:     ${fm.updated_at}\n` +
      `  description: ${fm.description}\n\n` +
      `--- Body ---\n\n${file.body}`,
  };
}

async function memoryDelete(cwd: string, name: string, scope?: Scope) {
  // 先验证存在性,避免静默无效操作;返回的 actualScope 用作提示
  const file = await readMemory(cwd, name, scope);
  const removed = await deleteMemory(cwd, name, file.scope);
  return { display: `Deleted memory "${name}" (scope=${removed}).` };
}

async function memoryPromote(cwd: string, name: string, scope?: Scope) {
  const before = await readMemory(cwd, name, scope);
  if (before.frontmatter.trust === "trusted") {
    return { display: `"${name}" (scope=${before.scope}) is already trusted (hierarchy-sourced).` };
  }
  if (before.frontmatter.trust === "verified") {
    return { display: `"${name}" (scope=${before.scope}) is already verified. Trusted is reserved for MUSE.md / AGENTS.md.` };
  }
  await setMemoryTrust(cwd, name, "verified", "user-edit", before.scope);
  return { display: `Promoted "${name}" (scope=${before.scope}): auto → verified.` };
}

async function memoryPromoteScope(cwd: string, name: string) {
  const promoted = await promoteScopeToUser(cwd, name);
  if (!promoted) return { display: `"${name}" is already in user scope; nothing to promote.` };
  return {
    display:
      `Promoted "${name}" scope: project → user.\n` +
      `It is now visible across ALL projects on this machine.\n` +
      `(source set to "promote-scope"; trust preserved.)`,
  };
}

/** /memory diagnose: 当前 embedding 状态 + 配置 + 修复建议。
 *  这是用户启用 embedding 后失败排查的入口。 */
async function memoryDiagnose(cwd: string, settings: import("../config/types.js").Settings) {
  const lines: string[] = ["Memory diagnose:"];
  const emb = settings.memory?.embedding;

  // 启用状态
  lines.push(``);
  lines.push(`  Embedding enabled:  ${emb?.enabled === true ? "YES" : "NO (default; using MEMORY.md full-text injection)"}`);
  if (!emb?.enabled) {
    lines.push(``);
    lines.push(`  To enable embedding recall, add to ~/.muse/settings.local.json:`);
    lines.push(`    {`);
    lines.push(`      "memory": {`);
    lines.push(`        "embedding": {`);
    lines.push(`          "enabled": true,`);
    lines.push(`          "preset": "dashscope-v3",      // or openai-3-small / ollama-nomic / etc.`);
    lines.push(`          "apiKey": "\${DASHSCOPE_API_KEY}"`);
    lines.push(`        }`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(``);
    lines.push(`  Available presets:`);
    for (const name of listPresetNames()) {
      const p = EMBEDDING_PRESETS[name];
      lines.push(`    ${name.padEnd(18)} dim=${String(p.dim).padEnd(5)} ${p.requiresKey ? "needs key" : "no key"}  — ${p.description}`);
    }
    return { display: lines.join("\n") };
  }

  // 配置详情
  lines.push(``);
  lines.push(`  Configuration:`);
  if (emb.preset) {
    const preset = EMBEDDING_PRESETS[emb.preset];
    if (preset) {
      lines.push(`    preset:           ${emb.preset}`);
      lines.push(`    preset baseUrl:   ${preset.baseUrl}${emb.baseUrl ? ` (overridden: ${emb.baseUrl})` : ""}`);
      lines.push(`    preset model:     ${preset.model}${emb.model ? ` (overridden: ${emb.model})` : ""}`);
      lines.push(`    preset dim:       ${preset.dim}${emb.dim !== undefined ? ` (overridden: ${emb.dim}, will send dimensions= parameter)` : ""}`);
      lines.push(`    needs apiKey:     ${preset.requiresKey ? "yes" : "no"}`);
    } else {
      lines.push(`    preset:           ${emb.preset}  ⚠ UNKNOWN preset!`);
      lines.push(`    Valid presets:    ${listPresetNames().join(", ")}`);
    }
  } else if (emb.provider) {
    lines.push(`    provider:         ${emb.provider} (custom)`);
    lines.push(`    baseUrl:          ${emb.baseUrl ?? "(missing)"}`);
    lines.push(`    model:            ${emb.model ?? "(missing)"}`);
    lines.push(`    dim:              ${emb.dim ?? "(missing)"}`);
  } else {
    lines.push(`    ⚠ Neither preset nor provider set — embedding will be disabled`);
  }
  lines.push(`    apiKey set:       ${emb.apiKey ? "yes (will be redacted in logs)" : "no"}`);
  lines.push(`    topK:             ${emb.topK ?? 5}  (default)`);
  lines.push(`    minMemoryCount:   ${emb.minMemoryCount ?? 3}  (default)`);
  lines.push(`    maxInjectTokens:  ${emb.maxInjectTokens ?? 1500}  (default)`);

  // 索引文件状态
  lines.push(``);
  lines.push(`  Index files (.index.json):`);
  for (const [label, dir] of [["project", memoryDir(cwd)], ["user", globalMemoryDir()]] as const) {
    const idxPath = join(dir, ".index.json");
    if (existsSync(idxPath)) {
      let size = 0;
      let mtime = "?";
      try {
        const st = statSync(idxPath);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {}
      lines.push(`    [${label}] ${idxPath}`);
      lines.push(`             size=${size}B  mtime=${mtime}`);
    } else {
      lines.push(`    [${label}] ${idxPath}  (not built yet)`);
    }
  }

  // 实时 probe(可选;只做轻量探针,不构建索引)
  lines.push(``);
  lines.push(`  Live probe:`);
  try {
    const provider = await createAndProbeProvider(emb);
    lines.push(`    ✓ provider OK  id=${provider.id}  dim=${provider.dim}`);
  } catch (err) {
    lines.push(`    ✗ FAILED: ${(err as Error).message}`);
    lines.push(``);
    lines.push(`  Fix suggestions:`);
    const msg = (err as Error).message;
    if (msg.includes("dimension mismatch")) {
      lines.push(`    → Model returned a different dim than configured. Set settings.memory.embedding.dim to the actual value shown above.`);
    } else if (msg.includes("requires apiKey")) {
      lines.push(`    → Set settings.memory.embedding.apiKey (\${ENV_VAR} supported).`);
    } else if (msg.includes("Unknown preset") || msg.includes("Unknown embedding")) {
      lines.push(`    → Valid presets: ${listPresetNames().join(", ")}`);
    } else if (msg.includes("HTTP 401") || msg.includes("Unauthorized")) {
      lines.push(`    → API key invalid. Re-check the env var or value.`);
    } else if (msg.includes("HTTP 429")) {
      lines.push(`    → Rate-limited or quota exhausted. Wait, or upgrade your plan.`);
    } else if (msg.includes("HTTP 404")) {
      lines.push(`    → Model not found. Check the model name; for Ollama, run \`ollama pull <model>\`.`);
    } else if (msg.includes("timeout") || msg.includes("network error")) {
      lines.push(`    → Network unreachable. Check baseUrl, firewall, VPN.`);
    } else {
      lines.push(`    → See the error above for details. Common causes: wrong key / model / baseUrl / network.`);
    }
    lines.push(``);
    lines.push(`  While embedding is broken, muse falls back to MEMORY.md full-text injection automatically.`);
  }

  return { display: lines.join("\n") };
}

/** /memory diff: 按 updated_at 降序列出 memory + 人类可读的"X 时间前"标签。 */
async function memoryDiff(cwd: string, scope?: Scope) {
  const list = await listMemories(cwd, { scope: scope ?? "all" });
  if (list.length === 0) {
    return { display: `(no memories to diff)\n\n${MEMORY_HELP}` };
  }
  const now = Date.now();
  const sorted = list.slice().sort((a, b) => {
    const ta = Date.parse(a.frontmatter.updated_at);
    const tb = Date.parse(b.frontmatter.updated_at);
    return tb - ta;
  });
  const lines = sorted.map((m) => {
    const t = Date.parse(m.frontmatter.updated_at);
    const ago = formatTimeAgo(now - t);
    const trustTag = `[${m.frontmatter.trust}]`.padEnd(11);
    const scopeTag = `[${m.scope}]`.padEnd(10);
    return `  ${ago.padEnd(20)} ${trustTag} ${scopeTag} ${m.frontmatter.name}  — ${m.frontmatter.description}`;
  });
  return {
    display:
      `Memories sorted by updated_at (most recent first):\n\n${lines.join("\n")}\n\n` +
      `Tip: use /memory view <name> for full content; /memory edit <name> to open in $EDITOR.`,
  };
}

function formatTimeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "(unknown)";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** /memory edit: 在 $VISUAL || $EDITOR || vi 中打开 memory 文件;退出后自动升 auto → verified。 */
async function memoryEdit(ctx: import("./types.js").SlashCommandContext, name: string, scope?: Scope) {
  // 找文件并校验存在
  const file = await readMemory(ctx.cwd, name, scope);
  const before = file.frontmatter.updated_at;
  const beforeBody = file.body;

  try {
    await ctx.actions.openInEditor(file.filePath);
  } catch (err) {
    return { display: `Editor failed: ${(err as Error).message}` };
  }

  // 重读检查变化
  let after;
  try {
    after = await readMemory(ctx.cwd, name, file.scope);
  } catch (err) {
    return { display: `Memory "${name}" no longer exists after edit (deleted or renamed).` };
  }

  const changed = after.frontmatter.updated_at !== before || after.body !== beforeBody;

  if (!changed) {
    return {
      display: `No changes to "${name}" (scope=${file.scope}).`,
    };
  }

  // 文件被改了 — 如果原 trust 是 auto,自动升 verified
  let trustNote = "";
  if (after.frontmatter.trust === "auto") {
    try {
      await setMemoryTrust(ctx.cwd, name, "verified", "user-edit", file.scope);
      trustNote = "\n  trust: auto → verified (user edit)";
    } catch (err) {
      trustNote = `\n  trust upgrade failed: ${(err as Error).message}`;
    }
  }

  return {
    display:
      `Saved memory "${name}" (scope=${file.scope})${trustNote}\n` +
      `  → ${file.filePath}`,
  };
}

async function memorySearch(cwd: string, query: string) {
  const index = await buildMemoryIndex(cwd);
  if (index.entries.length === 0) {
    return { display: `(no memories saved for this project)\n\nWrite some first with MemoryWrite (LLM-side) or /remember.` };
  }
  const results = await queryMemoryIndex(index, query, { topK: 5 });
  if (results.length === 0) {
    return { display: `(no memories matched "${query}")\n\nTry simpler keywords; current provider is "${index.provider.id}" — pure keyword + simple semantic matching.` };
  }
  const lines = results.map((r, i) => {
    const score = (r.score * 100).toFixed(1);
    const w = r.weighted.toFixed(3);
    return `  ${i + 1}. [${r.entry.trust}] [${r.entry.scope}] (${r.entry.type}) ${r.entry.name}   score=${score}% w=${w}\n     — ${r.entry.description}`;
  });
  return {
    display:
      `Top ${results.length} match${results.length === 1 ? "" : "es"} for "${query}":\n\n` +
      lines.join("\n\n") +
      `\n\n(provider: ${index.provider.id};  use /memory view <name> to see full content)`,
  };
}

async function memoryAssignTrust(cwd: string, name: string, levelArg: string, scope?: Scope) {
  if (!(TRUST_LEVELS as readonly string[]).includes(levelArg)) {
    return { display: `Invalid trust level: ${levelArg}. Use one of: ${TRUST_LEVELS.join(" / ")}.` };
  }
  if (levelArg === "trusted") {
    return {
      display:
        `Cannot set trust=trusted via /memory; trusted is reserved for hierarchy files ` +
        `(MUSE.md / AGENTS.md). To make this content trusted, move it into one of those files.`,
    };
  }
  await setMemoryTrust(cwd, name, levelArg as TrustLevel, "user-edit", scope);
  return { display: `Set "${name}" trust → ${levelArg}${scope ? ` (scope=${scope})` : ""}.` };
}

// ----- /remember -----

const REMEMBER_TIPS = [
  "Default scope is user (cross-project)",
  "Use --project to save only to current project",
  "trust=verified because YOU asked muse to remember",
  "Edit later via /memory view <name> or shell",
];

const REMEMBER: SlashCommand = {
  name: "remember",
  description: "save a memory from user-described text (LLM distills structure); default scope=user",
  argsHint: "[--user|--project] <text>",
  async execute(ctx) {
    const raw = ctx.args.trim();
    if (!raw) {
      return {
        display:
          `Usage: /remember [--user|--project] <text>\n` +
          `  Default scope is "user" (cross-project; saved to ~/.muse/memory/).\n` +
          `  Use --project to scope to current project only.\n` +
          `  muse will call the active LLM to extract { name, type, description, body }, ` +
          `then save with trust=verified, source=user-remember.`,
      };
    }
    // 解析 scope flag(必须在最前)
    let scope: Scope = "user";
    let text = raw;
    if (text.startsWith("--user")) {
      scope = "user";
      text = text.slice("--user".length).trim();
    } else if (text.startsWith("--project")) {
      scope = "project";
      text = text.slice("--project".length).trim();
    }
    if (!text) return { display: "Usage: /remember [--user|--project] <text>" };

    ctx.actions.showProgress({
      title: `Distilling memory (scope=${scope})`,
      tips: REMEMBER_TIPS,
    });
    try {
      const extracted = await distillMemoryStructure(ctx.llm, text, scope);
      if (!extracted) {
        return {
          display:
            `Failed to extract structured memory from your text.\n` +
            `Try a clearer statement, e.g.:\n` +
            `  /remember I prefer pnpm over npm in all projects\n` +
            `  /remember --project this team uses semantic-release for versioning`,
        };
      }
      const result = await writeMemory(ctx.cwd, {
        name: extracted.name,
        description: extracted.description,
        type: extracted.type,
        body: extracted.body,
        trust: "verified",
        source: "user-remember",
        scope,
      });
      const action = result.created ? "Created" : "Updated";
      return {
        display:
          `${action} memory "${extracted.name}"\n` +
          `  scope:       ${result.scope}\n` +
          `  type:        ${extracted.type}\n` +
          `  trust:       verified (source: user-remember)\n` +
          `  description: ${extracted.description}\n` +
          `  → ${result.filePath}`,
      };
    } finally {
      ctx.actions.hideProgress();
    }
  },
};

interface ExtractedMemory {
  name: string;
  type: MemoryType;
  description: string;
  body: string;
}

async function distillMemoryStructure(
  llm: LLMClient,
  userText: string,
  scope: Scope,
): Promise<ExtractedMemory | null> {
  const scopeNote =
    scope === "user"
      ? "user-level (cross-project preference / role / style)"
      : "project-level (specific to the current project)";
  const prompt =
    `User wants to save a long-term memory. Extract structured fields.\n\n` +
    `Target scope: ${scope} — ${scopeNote}\n\n` +
    `User said:\n"""\n${userText}\n"""\n\n` +
    `Reply with ONE json code block in this exact shape:\n\n` +
    "```json\n" +
    `{\n` +
    `  "name": "kebab-case-slug",\n` +
    `  "type": "user" | "feedback" | "project" | "reference",\n` +
    `  "description": "one-line summary, ≤ 80 chars",\n` +
    `  "body": "markdown body"\n` +
    `}\n` +
    "```\n\n" +
    `Field rules:\n` +
    `- name: kebab- or snake-style slug, ≤ 40 chars, captures the topic\n` +
    `- type: user(role/prefs) | feedback(validated practice) | project(decisions/facts) | reference(URL/path pointers)\n` +
    `- description: short hook used in MEMORY.md index\n` +
    `- body: markdown; for feedback/project, structure as: rule line + "Why: ..." + "How to apply: ..."\n\n` +
    `Output ONLY the json block. No prose before or after.`;

  let text = "";
  try {
    for await (const ev of llm.stream({ messages: [{ role: "user", content: prompt }] })) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "error") throw ev.error;
    }
  } catch {
    return null;
  }

  const m = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    const name = typeof parsed.name === "string" ? parsed.name : "";
    const description = typeof parsed.description === "string" ? parsed.description : "";
    const body = typeof parsed.body === "string" ? parsed.body : "";
    const type = parsed.type;
    if (!name || !description || !body) return null;
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) return null;
    if (type !== "user" && type !== "feedback" && type !== "project" && type !== "reference") return null;
    return { name, type, description, body };
  } catch {
    return null;
  }
}

// ----- registry -----

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  HELP,
  CLEAR,
  COMPACT,
  MODELS,
  CONFIG,
  MCP,
  MEMORY,
  REMEMBER,
  SKILL,
  MODE_CMD,
  COST,
  BTW,
  RESUME,
  EXIT,
];
