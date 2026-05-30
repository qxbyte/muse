/**
 * 内置 slash 命令：/help /clear /compact /model /config /mcp /cost /resume /quit
 *
 * 设计文档：muse-design.md §7.2 表中 9 条全部覆盖。
 *
 * 设计原则：命令体只编排（解析参数 → 调 actions / 领域模块 → 构造 display）。
 * 真正的业务（压缩、列 session、查 MCP）在各自的领域模块里。
 */

import type { SlashCommand, SlashCommandContext } from "./types.js";
import { estimateCostUSD, formatUSD, lookupPricing } from "../llm/pricing.js";
import { redactApiKey } from "../log/index.js";
import { compactMessages } from "../loop/context.js";
import { getMCPStatus } from "../mcp/index.js";
import { Session } from "../session/jsonl.js";
import { loadModelsRegistry, visibleEntries, type LoadError } from "../config/models.js";
import { shortPath, formatList, parseArgs, formatTime } from "./_format.js";
import { MODE_CYCLE, MODE_LABEL, type PermissionMode } from "../permission/index.js";

// ----- /help -----

const HELP: SlashCommand = {
  name: "help",
  description: "show available slash commands",
  execute(ctx) {
    const cmds = ctx.listCommands();
    const heads = cmds.map(headOf);
    const width = Math.max(...heads.map((h) => h.length));
    const lines = ["Built-in commands:"];
    for (let i = 0; i < cmds.length; i++) {
      const aliasNote = cmds[i].aliases?.length
        ? `  (alias: ${cmds[i].aliases!.map((a) => `/${a}`).join(", ")})`
        : "";
      lines.push(`  /${heads[i].padEnd(width)}   ${cmds[i].description}${aliasNote}`);
    }
    lines.push("", "Keys:  Ctrl+C  exit");
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

// ----- /quit -----

const QUIT: SlashCommand = {
  name: "quit",
  aliases: ["exit"],
  description: "exit Muse",
  execute() {
    return { exit: true };
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
        onProgress: (chars) => {
          progressRef.chars = chars;
        },
      });
      if (result.noop) {
        return { display: `(history has ${result.originalCount} messages; not enough to compact with --keep ${keepRecent})` };
      }
      ctx.actions.setMessages(result.newMessages);
      const preview = result.summary.length > 240 ? result.summary.slice(0, 240) + "…" : result.summary;
      return {
        display:
          `Compacted ${result.originalCount} → ${result.newCount} messages ` +
          `(kept last ${keepRecent}).\n\nSummary:\n${preview}`,
      };
    } finally {
      ctx.actions.hideProgress();
    }
  },
};

// ----- /models -----

const MODELS: SlashCommand = {
  name: "models",
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

    const visible = visibleEntries(registry);
    if (visible.length === 0) {
      return {
        display:
          `models.local.json has no available models.\n` +
          `Check that "availableModels" lists at least one id present in "models".`,
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
    `Fix the file above, then run /models again (it re-reads on each call).`,
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
    `  ],`,
    `  "availableModels": ["<your-model-id>"]`,
    `}`,
    ``,
    `Then run /models again (no restart needed).`,
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

// ----- /mcp -----

const MCP: SlashCommand = {
  name: "mcp",
  description: "show MCP server status",
  execute(ctx) {
    const status = getMCPStatus(ctx.settings);
    if (status.length === 0) {
      return {
        display:
          `No MCP servers configured.\n` +
          `Add servers under "mcpServers" in your settings.json.\n` +
          `Note: MCP client integration is planned for v0.3; current /mcp only inspects configuration.`,
      };
    }
    const lines = [`MCP servers (${status.length}):`];
    for (const s of status) {
      const indicator = s.connected ? "●" : "○";
      lines.push(`  ${indicator} ${s.name}`);
      lines.push(`      configured: ${s.configured}`);
      lines.push(`      connected:  ${s.connected}${s.error ? `  (${s.error})` : ""}`);
      if (s.connected) lines.push(`      tools:      ${s.toolCount}`);
      if (s.config?.command) lines.push(`      command:    ${s.config.command}${s.config.args ? " " + s.config.args.join(" ") : ""}`);
      if (s.config?.url) lines.push(`      url:        ${s.config.url}`);
    }
    return { display: lines.join("\n") };
  },
};

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

// ----- registry -----

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  HELP,
  CLEAR,
  COMPACT,
  MODELS,
  CONFIG,
  MCP,
  MODE_CMD,
  COST,
  BTW,
  RESUME,
  QUIT,
];
