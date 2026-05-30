# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Muse 项目约束

> 在本仓库工作的 AI 编码助手的硬约束。项目介绍 / 设计 / 路线图 / 目录结构 → 见文档库
> `/Volumes/External HD/Obsidian/Notes/Ideas/Muse/`。本文件**只**列规则 + 必要的入门导航。

---

## 常用命令

```bash
npm install                          # 安装依赖（首次 / 拉新依赖）
npm run dev                          # tsup --watch，开发时持续构建
npm run build                        # 生产构建（tsup → dist/）
npm run typecheck                    # tsc --noEmit，CI 必跑
npm test                             # vitest run（一次性）
npm run test:watch                   # vitest watch
npm run start                        # 跑构建产物 node ./dist/cli.js
npx vitest run test/permission.test.ts   # 跑单个测试文件
npx vitest run -t "denies rm -rf"        # 按测试名跑

# 本地端到端测试（构建后）
node ./dist/cli.js --version
node ./dist/cli.js "总结一下 src/cli.tsx"   # 一次性 prompt
node ./dist/cli.js                          # 交互 TUI
node ./dist/cli.js --debug                  # 详细日志写 ~/.muse/logs/<date>.jsonl
```

`prepublishOnly` 会跑 `typecheck && build`；发包前不用手动跑两遍。

---

## 架构总览

入口流：

```
src/cli.tsx                          # commander 解析 argv，加载 settings/models
  ↓                                  # 构造 LLMClient / ToolRegistry / PermissionGate / Session
  ├─→ runOneShot()                   # 有 prompt（含 stdin 管道）→ 单次执行后退出
  └─→ render(<App/>)  (src/app.tsx)  # 交互模式：Ink TUI + slash + 流式渲染
        ↓
        Agent (src/loop/agent.ts)    # ReAct 单循环：stream → 累计 tool_use → 权限检查 → 跑工具 → 回灌结果 → 再 stream
```

核心模块（要改动前先理解的"大块"）：

- **`src/loop/agent.ts`** — Agent ReAct 循环。LLM 流事件 (`text` / `tool_use` / `finish`) 在 `handleEvent` 里累计；一段流结束后 `executePendingTools` 走权限网关并并发跑工具，把结果以 `role: "tool"` 消息推回 messages 数组，再开下一轮 stream。`TodoStore` 每轮把待办清单拼到 system prompt 末尾。
- **`src/llm/`** — LLM 抽象。当前只有 `OpenAICompatibleClient`（覆盖 OpenAI / DeepSeek / Qwen / Kimi / GLM / Ollama / 自托管）；Anthropic 留 v0.3。`createLLMClientFromModelEntry` 从 `~/.muse/models.local.json` 的 entry 构造，**apiKey 不直接传值**——先 `setActiveModelEnv()` 写到 `process.env.MUSE_ACTIVE_API_KEY`，client 从 env 读。
- **`src/tools/`** — 工具注册中心 + 11 个内置工具（Read/Write/Edit/Bash/Grep/Glob/TodoWrite/WebFetch/MemoryRead/MemoryWrite/AskUserQuestion）。`registry.ts` 内的 `zodToJsonSchema` 把 zod schema 转成 LLM tool definition 喂给 provider；Bash 工具内部有 `HARD_DENY_PATTERNS`（rm -rf / sudo / curl|sh 等）所有权限模式都绕不过。
- **`src/permission/`** — 三态 `allow / ask / deny` × 4 档 `PermissionMode`：
  - `default` 走 settings 规则，`acceptEdits` 自动放行 Edit/Write，`plan` 只允许 read 类，`bypassPermissions` 除 deny 与硬拒绝外全放行
  - 模式不持久化，Shift+Tab 在 TUI 里循环切换
  - Pattern 格式：`"ToolName"` / `"Bash(<prefix>)"` / `"Bash(<prefix>:*)"`
- **`src/config/`** — 配置 5 层叠加（defaults → `~/.muse/settings.json` → `<cwd>/.muse/settings.json` → `<cwd>/.muse/settings.local.json` → env → CLI flags）。`${ENV_VAR}` 占位符在加载后展开。`models.local.json` **只有** `~/.muse/` 层（模型仓库本质 user-level），见 `src/config/models.ts`。
- **`src/session/jsonl.ts`** — append-only JSONL，路径 `~/.muse/projects/<sha256(cwd)[:16]>/sessions/<uuid>.jsonl`。每条事件一行（session_start / message / usage / session_end）。`/resume` 与 `--continue` 从这里恢复。
- **`src/slash/`** — Slash 命令系统。`builtin.ts` 注册 10 条内置命令；命令体只编排（解析参数 → 调 `SlashActions` / 领域模块 → 返回 `display`），真正业务在领域模块里（如 `loop/context.ts` 的 compact、`config/models.ts` 的 registry 读写）。返回 `{ display }` 会被追加为 assistant 消息；返回 `{}` 则不入历史（`/btw` 浮层用此机制）。
- **`src/app.tsx`** — Ink 根组件。`llm` / `settings` / `modelsRegistry` 是 mutable state——`/models` / `/config reload` 通过 setter 触发 **Agent 重建**；`messagesRef` 跨重建保留 messages。permission prompt / model selector / session selector / question picker 都是 modal overlay。
- **`src/loop/system-prompt.ts`** — 系统提示拼装。注意：`Available tools` 段会把 `ToolRegistry.list()` 当前可见的工具名全部塞进去，所以新增工具自动暴露给 LLM；plan 模式下 Agent 会过滤掉非 read 工具再传给 LLM（不只是拦截执行）。

跨模块要点：

- **添加新工具**：在 `src/tools/builtin/` 新建文件 → 在 `src/tools/builtin/index.ts` 的 `BUILTIN_TOOLS` 数组追加 → 走 zod schema 定义参数。无需改 system prompt 或 LLM client。
- **添加新 slash 命令**：在 `src/slash/builtin.ts` 写 `SlashCommand` 对象 → 加进 `BUILTIN_SLASH_COMMANDS`。命令体里通过 `ctx.actions` 操作 LLM/Settings/Session。
- **新增 LLM provider**：除非协议非 OpenAI 兼容，否则**只用配 `models.local.json` 里的 entry 即可**，不动代码。新协议（如 Anthropic native）才需要新 client 实现 `LLMClient` 接口。
- **改 system prompt**：改 `src/loop/system-prompt.ts`；不要在工具里塞"提示词"——工具的 `description` 已经走进 LLM tool definition 了。

---

## 文档库（Single Source of Truth）

**目录**：`/Volumes/External HD/Obsidian/Notes/Ideas/Muse/`

- 主设计：`muse-design.md`（架构、技术栈、路线图、14 章正文）
- 实现日志：`implementation-log.md`（倒序追加，每会话一节）
- 子规范：`startup-banner.md` 等

**接手会话三步**：读 `implementation-log.md` 最新一节 → 本文件 → `muse-design.md` 对应章节。

**约定**：

- 实现前先看 `muse-design.md` 对应章节；偏离设计 → 在 `implementation-log.md` 留 ADR 风格记录
- 阶段完成 → 在 `implementation-log.md` **追加**新章节（顶部，`---` 之后），不覆盖、不删旧
- 新规范 / 设计文档 → 落文档库，命名 kebab-case；**不要**落项目根 / `docs/` / 桌面 / `~/`
- 临时分析 / 对比 / 计划 md → 不落盘
- 工作流（specode 等）产物 → 按工作流自身规则落，不搬迁
- 源代码里不粘贴设计文档内容；用注释引用章节（如 `// 见 muse-design.md §7.2`）
- 代码细节 / ADR 可落项目内 `docs/`，但宏观决策必须落文档库

---

## 技术栈（不擅自更换 / 升级）

Node.js >= 20 · TypeScript `strict` · tsup · vitest · Ink · commander · Vercel AI SDK (`ai` + `@ai-sdk/*`) · `@modelcontextprotocol/sdk` · zod · execa · fast-glob · `diff` (jsdiff) · pino。

包管理用 **npm**（用户机器无 pnpm，**不要**主动 `npm i -g pnpm` 或换 bun / yarn）。

---

## 代码风格

- ESM only，`package.json "type": "module"`
- 文件 kebab-case；组件文件 PascalCase（`StartupBanner.tsx`）
- 优先 named export，避免 default export（框架强制除外）
- React 函数组件 + hooks
- 错误处理只在系统边界（用户输入 / 外部 API / 子进程）显式 try/catch；内部代码信任契约
- 注释只写 WHY，不解释 WHAT；单行 `//` 为主，不写多段 docstring
- 不写死代码 / 半成品 / "未来可能用到"的抽象（三处相似再抽提）

---

## 提交规范

- commit message 中文，格式 `<动词> <范围>: <内容>`（如 `add tools: 实现 Read 工具`）
- 一次 commit 聚焦一件事；功能 / 重构 / 测试分开
- **不擅自 git commit / push**；只在用户明说"提交 / commit / push"时执行
- Claude 写的 commit message 末尾加 `Co-Authored-By` 行

---

## 安全

- 不读 `~/.ssh/` `~/.aws/` `~/.gnupg/` `.env`
- 不执行 `rm -rf` `sudo` `curl ... | sh` 等危险命令
- API key 仅走环境变量或 `settings.local.json`（chmod 600）；**绝不**写进源码 / `settings.json`
- 日志、错误信息中 API key 脱敏（前 4 后 4）

---

## 应急

- 跑不通 / 装不上 / 缺权限 → **不**绕过；在 `implementation-log.md` 留 TODO 让用户处理
- 设计文档冲突 / 缺失 → 按最合理推断走，在 `implementation-log.md` 标注 `[需确认]`
- 命名 / 接口不确定 → 选生态最通用的方式（OpenAI 兼容协议 / MCP / 主流 npm 包惯例）
