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
import { buildSystemPrompt } from "./loop/system-prompt.js";
import { loadMemoryIndex } from "./loop/memory.js";
import { MuseError } from "./types/index.js";
import { log } from "./log/index.js";

const VERSION = "0.1.0";

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
        // models.json 里找到 settings.llm.model（或 -m）对应的 entry：
        // 注入 apiKey 到 process.env.MUSE_ACTIVE_API_KEY，业务通过 env 读
        const entry = modelsRegistry && model ? findEntry(modelsRegistry, model) : undefined;
        if (entry) {
          setActiveModelEnv(entry);
          llm = createLLMClientFromModelEntry(entry);
          llmProviderName = llm.providerName;
          llmModelName = llm.model;
        } else {
          // 优先级 2：回退到 settings.json 原生 provider/model + providers 配置
          if (!provider || !model) {
            die("No model configured. Either define one in ~/.muse/models.json or set llm.provider+llm.model in settings.json.");
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
  cwd: string;
  lang: "en" | "zh-CN";
  prompt: string;
  quiet: boolean;
  initialMessages?: import("./types/index.js").Message[];
}): Promise<void> {
  const memoryIndex = await loadMemoryIndex(opts.cwd);
  const systemPrompt = buildSystemPrompt({
    cwd: opts.cwd,
    model: opts.llm.model,
    provider: opts.llm.providerName,
    lang: opts.lang,
    toolNames: opts.tools.list().map((t) => t.name),
    memoryIndex,
  });
  const agent = new Agent({
    llm: opts.llm,
    tools: opts.tools,
    permissions: opts.permissions,
    session: opts.session,
    cwd: opts.cwd,
    systemPrompt,
    events: {
      onText: (delta) => process.stdout.write(delta),
      onToolCallStart: (_id, name) => {
        if (!opts.quiet) process.stderr.write(`\n→ ${name}\n`);
      },
      onError: (err) => process.stderr.write(`\n[error] ${err.message}\n`),
      onPermissionRequest: async (toolName, _args, summary) => {
        // 非交互模式：deny 所有需要 ask 的工具
        if (!opts.quiet) process.stderr.write(`\n[denied: ${toolName} — ${summary}; run in interactive mode to approve]\n`);
        return "no";
      },
    },
  });
  if (opts.initialMessages?.length) agent.setMessages(opts.initialMessages);
  await agent.runTurn(opts.prompt);
  process.stdout.write("\n");
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
