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
import { InputPipeline, createInputCtx, buildUserMessage } from "./preprocess/input/index.js";
import { RequestPipeline } from "./preprocess/request/index.js";
import { ResultPipeline } from "./preprocess/result/index.js";
import { runHooks } from "./preprocess/hooks.js";
import { PipelineBlockedError } from "./preprocess/pipeline.js";
import { MuseError } from "./types/index.js";
import { log } from "./log/index.js";
import { VERSION } from "./version.js";

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
  cwd: string;
  lang: "en" | "zh-CN";
  prompt: string;
  quiet: boolean;
  initialMessages?: import("./types/index.js").Message[];
}): Promise<void> {
  const memoryIndex = await loadMemoryIndex(opts.cwd);
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
    requestPipeline,
    requestServices: {
      todos,
      memoryIndex,
      toolRegistry: opts.tools,
      lang: opts.lang,
      provider: opts.llm.providerName,
      extraSystemPrompt,
    },
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
