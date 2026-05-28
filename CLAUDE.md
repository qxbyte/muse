# Muse 项目约束

> Claude Code 在本仓库工作的硬约束。项目介绍 / 设计 / 路线图 / 目录结构 → 见文档库
> `/Volumes/External HD/Obsidian/Notes/Ideas/Muse/`。本文件**只**列规则。

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
- 命名 / 接口不确定 → 选最像 Claude Code 的方式（生态兼容优先）
