/**
 * CLI 入口。解析 argv → 加载配置 → 启动交互或单次模式。
 */

import React from "react";
import { Command } from "commander";
import { render } from "ink";
import { App } from "./app.js";
import { loadSettings } from "./config/index.js";
import { loadModelsRegistry, findEntry } from "./config/models.js";
import { createLLMClient, createLLMClientFromModelEntry, setActiveModelEnv } from "./llm/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { BUILTIN_TOOLS } from "./tools/builtin/index.js";
import { PermissionGate } from "./permission/index.js";
import { Session } from "./session/jsonl.js";
import { Agent } from "./loop/agent.js";
import { TodoStore } from "./loop/todos.js";
import { loadMemoryIndex } from "./loop/memory.js";
import { loadHierarchy } from "./loop/hierarchy.js";
import { buildMemoryIndex, type MemoryIndex } from "./loop/memory-index.js";
import { loadSkills } from "./skills/loader.js";
import type { SkillRegistry, SkillFile } from "./skills/types.js";
import { loadEnabledPlugins } from "./plugins/index.js";
import type { HooksConfig } from "./config/types.js";
import type { SlashCommand } from "./slash/types.js";
import { MCPManager } from "./mcp/index.js";
import { InputPipeline, createInputCtx, buildUserMessage } from "./preprocess/input/index.js";
import { RequestPipeline } from "./preprocess/request/index.js";
import { ResultPipeline } from "./preprocess/result/index.js";
import { runHooks } from "./preprocess/hooks.js";
import { PipelineBlockedError } from "./preprocess/pipeline.js";
import { MuseError } from "./types/index.js";
import { log } from "./log/index.js";
import { VERSION } from "./version.js";

/** 把 plugin 贡献的 hooks 链式并入 settings.hooks(同 point concat)。 */
function mergeHooksConfig(base: HooksConfig | undefined, add: HooksConfig): HooksConfig {
  const out = { ...(base ?? {}) } as Record<string, unknown[]>;
  for (const [point, specs] of Object.entries(add)) {
    if (!specs) continue;
    out[point] = [...(out[point] ?? []), ...(specs as unknown[])];
  }
  return out as HooksConfig;
}

async function main() {
  const program = new Command();

  program
    .name("muse")
    .description("A TypeScript agent CLI built around OpenAI-compatible APIs. First-class support for self-hostable and Chinese LLMs.")
    .version(VERSION, "-v, --version", "print version");

  program
    .argument("[prompt...]", "one-shot prompt (omit for interactive mode)")
    .option("-m, --model <model>", "override model")
    .option("-p, --provider <provider>", "override provider")
    .option("--no-banner", "skip startup banner")
    .option("--quiet", "minimal output (implies --no-banner)")
    .option("--continue", "resume last session in this directory")
    .option("--mode <mode>", "initial permission mode (default|acceptEdits|plan|bypassPermissions)")
    .option("--debug", "verbose logging")
    .action(async (promptArgs: string[], opts: CliOptions) => {
      if (opts.debug) log.setLevel("debug");

      const cwd = process.cwd();
      const { settings, sources } = await loadSettings(cwd);
      const { registry: modelsRegistry, sources: modelsSources } = await loadModelsRegistry();
      log.debug("config loaded", { settingsSources: sources, modelsSources });

      // O2:image token 估算常量(模块级单例;tokenize 模块在此一次性应用)
      const imgTok = settings.preprocess?.request?.tokenize?.imageTokenEstimate;
      if (typeof imgTok === "number") {
        const { setImageTokenEstimate } = await import("./preprocess/tokenize.js");
        setImageTokenEstimate(imgTok);
      }

      const model = opts.model ?? settings.llm?.model;
      const provider = opts.provider ?? settings.llm?.provider;

      let llm;
      let llmProviderName: string;
      let llmModelName: string;
      try {
        // models.local.json 里找到 settings.llm.model(或 -m)对应的 entry:
        // 注入 apiKey 到 process.env.MUSE_ACTIVE_API_KEY,业务通过 env 读
        const entry = modelsRegistry && model ? findEntry(modelsRegistry, model) : undefined;
        if (entry) {
          setActiveModelEnv(entry);
          llm = createLLMClientFromModelEntry(entry);
          llmProviderName = llm.providerName;
          llmModelName = llm.model;
        } else if (modelsRegistry && model) {
          // 有 registry 但 model id 在里面找不到 — 大概率是 settings.llm.model 跟
          // models.local.json 里 entry.id 不一致(常见原因:用户改了一边没改另一边)。
          //
          // **不要** 静默 fallback 到 settings.providers + DEFAULTS 的默认 provider —
          // 那会绕一圈报"缺 DEEPSEEK_API_KEY",让用户摸不着头脑。直接给清晰错。
          const availableIds = modelsRegistry.models.map((m) => m.id);
          const lines = [
            `Active model "${model}" not found in ~/.muse/models.local.json.`,
            ``,
            `Available ids:`,
            ...availableIds.map((id) => `  - ${id}`),
            ``,
            `Fix one of these:`,
            `  1) Edit ~/.muse/settings.json: set "llm.model" to one of the ids above.`,
            `  2) Edit ~/.muse/models.local.json: rename an entry.id to match "${model}".`,
            `  3) Run muse with --model <id> to override once.`,
          ];
          die(lines.join("\n"));
        } else {
          // 没 registry / settings.llm.model 没设 → 回退到 settings.json 原生 provider/model
          if (!provider || !model) {
            die("No model configured. Either define one in ~/.muse/models.local.json or set llm.provider+llm.model in settings.json.");
          }
          llm = createLLMClient({ provider, model, providers: settings.providers ?? {} });
          llmProviderName = provider;
          llmModelName = model;
        }
      } catch (err) {
        if (err instanceof MuseError) die(err.message);
        throw err;
      }

      const tools = new ToolRegistry();
      tools.registerAll(BUILTIN_TOOLS);

      const permissions = new PermissionGate(settings.permissions);

      // --mode 启动期指定 PermissionMode；后续 Shift+Tab / /mode 仍可切换
      if (opts.mode) {
        const valid = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
        if (!(valid as readonly string[]).includes(opts.mode)) {
          die(`Invalid --mode "${opts.mode}". Valid: ${valid.join(", ")}`);
        }
        permissions.setMode(opts.mode as (typeof valid)[number]);
      }

      // --continue: 复用最近一次 session 的 jsonl + messages
      let session: Session;
      let initialMessages: import("./types/index.js").Message[] | undefined;
      if (opts.continue) {
        const latest = await Session.findLatest(cwd);
        if (latest) {
          const opened = await Session.open(latest);
          session = opened.session;
          initialMessages = Session.messagesFromEvents(opened.events);
          log.debug("resumed session", { id: latest.id, messages: initialMessages.length });
        } else {
          session = await Session.create(cwd);
          await session.append({
            type: "session_start",
            time: new Date().toISOString(),
            cwd,
            provider: llmProviderName,
            model: llmModelName,
          });
        }
      } else {
        session = await Session.create(cwd);
        await session.append({
          type: "session_start",
          time: new Date().toISOString(),
          cwd,
          provider: llmProviderName,
          model: llmModelName,
        });
      }

      const showBanner = !opts.quiet && opts.banner !== false;
      const lang = settings.ui?.lang ?? "en";

      // Plugins(模块设计/Plugins/设计.md v0.4):启动期全量加载已启用 plugin。
      // 贡献的 skills 进 skill 层、mcpServers 并入 settings、hooks 并入 settings、
      // tools 注册进 ToolRegistry、slash 传给 App。失败不阻塞。
      let pluginSlashCommands: SlashCommand[] = [];
      const pluginSkills: SkillFile[] = [];
      if (settings.enabledPlugins && Object.values(settings.enabledPlugins).some(Boolean)) {
        const { contributions, result } = await loadEnabledPlugins({
          enabledPlugins: settings.enabledPlugins,
          cwd,
          logger: log,
        });
        pluginSkills.push(...contributions.skills);
        pluginSlashCommands = contributions.slash;
        if (Object.keys(contributions.mcpServers).length > 0) {
          settings.mcpServers = { ...(settings.mcpServers ?? {}), ...contributions.mcpServers };
        }
        if (Object.keys(contributions.hooks).length > 0) {
          settings.hooks = mergeHooksConfig(settings.hooks, contributions.hooks);
        }
        for (const t of contributions.tools) {
          if (tools.has(t.name)) {
            log.warn(`[plugins] tool "${t.name}" already registered; skipped`);
            continue;
          }
          tools.register(t);
        }
        if (!opts.quiet) {
          process.stderr.write(`[plugins] loaded ${result.loaded.length} plugin(s)\n`);
          for (const e of result.errors) {
            process.stderr.write(`[plugins] ${e.plugin}: ${e.reason}\n`);
          }
        }
      }

      // Skills(扩展接入口 §五):settings.skills.enabled=true 或有 plugin 贡献的 skills 时加载。
      // 失败不阻塞 muse,errors 写 stderr
      let skillRegistry: SkillRegistry | undefined;
      if (settings.skills?.enabled || pluginSkills.length > 0) {
        const { registry, errors } = await loadSkills(cwd, {
          personalDir: settings.skills?.personalDir,
          projectDir: settings.skills?.projectDir,
          disabled: settings.skills?.disabled,
          pluginSkills,
        });
        skillRegistry = registry;
        if (!opts.quiet) {
          process.stderr.write(`[skills] loaded ${registry.size()} skill(s)\n`);
          for (const e of errors) {
            process.stderr.write(`[skills] skipped ${e.path}: ${e.reason}\n`);
          }
        }
      }

      // MCP(扩展接入口 §四):懒加载 — 启动期仅记 manifest;首次工具调用时 spawn
      let mcpManager: MCPManager | undefined;
      if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
        mcpManager = new MCPManager({
          servers: settings.mcpServers as Record<string, import("./mcp/index.js").MCPServerConfig>,
          toolRegistry: tools,
        });
        const n = mcpManager.init();
        if (!opts.quiet && n > 0) {
          process.stderr.write(`[mcp] ${n} server(s) configured (lazy — connect on first tool call)\n`);
        }
      }

      // Pipe input → 拼成一次性 prompt
      const pipedInput = await readStdinIfPiped();
      const oneShotPrompt = [...(promptArgs ?? []), pipedInput].filter(Boolean).join("\n").trim();

      if (oneShotPrompt) {
        await runOneShot({
          llm,
          tools,
          permissions,
          session,
          settings,
          modelsRegistry,
          skillRegistry,
          mcpManager,
          cwd,
          lang,
          prompt: oneShotPrompt,
          quiet: opts.quiet ?? false,
          initialMessages,
        });
        return;
      }

      // Interactive mode
      const { waitUntilExit } = render(
        <App
          llm={llm}
          tools={tools}
          permissions={permissions}
          session={session}
          settings={settings}
          settingsSources={sources}
          modelsRegistry={modelsRegistry}
          modelsSources={modelsSources}
          skillRegistry={skillRegistry}
          pluginSlashCommands={pluginSlashCommands}
          mcpManager={mcpManager}
          cwd={cwd}
          lang={lang}
          showBanner={showBanner}
          initialMessages={initialMessages}
        />,
      );
      await waitUntilExit();
    });

  await program.parseAsync(process.argv);
}

interface CliOptions {
  model?: string;
  provider?: string;
  banner?: boolean;
  quiet?: boolean;
  continue?: boolean;
  mode?: string;
  debug?: boolean;
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function runOneShot(opts: {
  llm: ReturnType<typeof createLLMClient>;
  tools: ToolRegistry;
  permissions: PermissionGate;
  session: Session;
  settings: import("./config/types.js").Settings;
  modelsRegistry?: import("./config/models.js").ModelsRegistry;
  skillRegistry?: SkillRegistry;
  mcpManager?: MCPManager;
  cwd: string;
  lang: "en" | "zh-CN";
  prompt: string;
  quiet: boolean;
  initialMessages?: import("./types/index.js").Message[];
}): Promise<void> {
  const memoryIndex = await loadMemoryIndex(opts.cwd);
  const hierarchy = await loadHierarchy(opts.cwd);
  // II-5:启用时构建 memory embedding index(失败完全降级,不阻塞 muse 启动)
  let memoryEmbeddingIndex: MemoryIndex | undefined;
  if (opts.settings.memory?.embedding?.enabled) {
    try {
      memoryEmbeddingIndex = await buildMemoryIndex(opts.cwd, {
        config: opts.settings.memory.embedding,
      });
      if (!opts.quiet) {
        const entries = memoryEmbeddingIndex.entries.length;
        process.stderr.write(
          `[memory] embedding ready: provider=${memoryEmbeddingIndex.provider.id}, indexed ${entries} memor${entries === 1 ? "y" : "ies"}\n`,
        );
      }
    } catch (err) {
      if (!opts.quiet) {
        process.stderr.write(
          `[memory] embedding init failed: ${(err as Error).message}\n` +
            `[memory] falling back to MEMORY.md full-text mode (memory still works, just keyword-based).\n` +
            `         Run \`/memory diagnose\` inside muse for details and fix suggestions.\n`,
        );
      }
    }
  }
  const sessionStartTime = Date.now();

  // SessionStart hook
  let extraSystemPrompt = "";
  try {
    const out = await runHooks(
      "SessionStart",
      { cwd: opts.cwd, mode: opts.permissions.getMode(), modelId: opts.llm.model },
      opts.settings.hooks,
    );
    if (typeof out.extraSystemPrompt === "string") extraSystemPrompt = out.extraSystemPrompt;
  } catch (err) {
    if (!opts.quiet) process.stderr.write(`[SessionStart hook error] ${(err as Error).message}\n`);
  }

  // InputPipeline:CLI 单次场景没有 paste registry,paste-expand 自然 noop
  const activeEntry = opts.modelsRegistry ? findEntry(opts.modelsRegistry, opts.llm.model) : undefined;
  const inputCtx = createInputCtx({
    raw: opts.prompt,
    source: "argv",
    cwd: opts.cwd,
    mode: opts.permissions.getMode(),
    settings: opts.settings.preprocess?.input,
    capabilities: { supportsImages: activeEntry?.supportsImages ?? false },
  });
  const inputPipeline = InputPipeline({ disable: opts.settings.preprocess?.disable });
  try {
    await inputPipeline.run(inputCtx);
  } catch (err) {
    process.stderr.write(`[input pipeline error] ${(err as Error).message}\n`);
    return;
  }
  // slash 命令在 one-shot 模式无意义,提示后退出
  if (inputCtx.slashCommand) {
    process.stderr.write(`[ignored] slash commands are only available in interactive mode.\n`);
    return;
  }
  if (!opts.quiet) {
    for (const w of inputCtx.warnings) process.stderr.write(`[${w.stage}] ${w.message}\n`);
  }

  // UserPromptSubmit hook
  try {
    const hookOut = await runHooks(
      "UserPromptSubmit",
      { text: inputCtx.text, attachments: inputCtx.attachments, source: inputCtx.source },
      opts.settings.hooks,
    );
    if (typeof hookOut.text === "string") inputCtx.text = hookOut.text;
  } catch (err) {
    if (err instanceof PipelineBlockedError) {
      process.stderr.write(`[blocked by UserPromptSubmit hook] ${err.reason}\n`);
      return;
    }
    process.stderr.write(`[UserPromptSubmit hook error] ${(err as Error).message}\n`);
    return;
  }

  const todos = new TodoStore();
  const requestPipeline = RequestPipeline({ disable: opts.settings.preprocess?.disable });
  const resultPipeline = ResultPipeline({ disable: opts.settings.preprocess?.disable });

  const agent = new Agent({
    llm: opts.llm,
    tools: opts.tools,
    permissions: opts.permissions,
    session: opts.session,
    cwd: opts.cwd,
    todos,
    skillRegistry: opts.skillRegistry,
    mcpManager: opts.mcpManager,
    requestPipeline,
    requestServices: {
      todos,
      memoryIndex,
      hierarchy,
      memoryEmbeddingIndex,
      memoryEmbeddingTopK: opts.settings.memory?.embedding?.topK,
      memoryEmbeddingMinCount: opts.settings.memory?.embedding?.minMemoryCount,
      skills: opts.skillRegistry?.list(),
      toolRegistry: opts.tools,
      lang: opts.lang,
      provider: opts.llm.providerName,
      extraSystemPrompt,
    },
    requestSettings: opts.settings.preprocess?.request,
    resultPipeline,
    resultSettings: opts.settings.preprocess?.result,
    hooks: opts.settings.hooks,
    events: {
      onText: (delta) => process.stdout.write(delta),
      onToolCallStart: (_id, name) => {
        if (!opts.quiet) process.stderr.write(`\n→ ${name}\n`);
      },
      onError: (err) => process.stderr.write(`\n[error] ${err.message}\n`),
      onPermissionRequest: async (toolName, _args, summary) => {
        // 非交互模式:deny 所有需要 ask 的工具
        if (!opts.quiet) process.stderr.write(`\n[denied: ${toolName} — ${summary}; run in interactive mode to approve]\n`);
        return "no";
      },
    },
  });
  if (opts.initialMessages?.length) agent.setMessages(opts.initialMessages);
  await agent.runTurn(buildUserMessage(inputCtx));
  process.stdout.write("\n");

  // SessionEnd hook(fire-and-forget;不影响退出码)
  try {
    await runHooks(
      "SessionEnd",
      { durationMs: Date.now() - sessionStartTime, turnCount: 1 },
      opts.settings.hooks,
    );
  } catch {}
}

function die(msg: string): never {
  process.stderr.write(`muse: ${msg}\n`);
  process.exit(1);
}

main().catch((err) => {
  log.error("fatal", { msg: err instanceof Error ? err.message : String(err) });
  process.stderr.write(`muse: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
