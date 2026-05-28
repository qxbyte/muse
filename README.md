# Muse

> A TypeScript agent CLI built around OpenAI-compatible APIs. First-class support for self-hostable and Chinese LLMs (DeepSeek, Qwen, Kimi, GLM, Ollama, MiMo).

**状态：v0.1 MVP 搭建中**。API 不稳定，配置格式可能调整。

---

## 是什么

一个 TypeScript 写的命令行 Agent，Ink TUI 交互。LLM 后端走 OpenAI 兼容协议，国产模型 / 本地模型 / 自部署网关都是一等公民。

适合：

- 在国内网络环境下需要一个能跑的 agent CLI
- 想用 DeepSeek / Qwen / Kimi / GLM / MiMo / Ollama / 自建 vLLM 等
- 希望 model 可热切换、凭证不写源码、会话本地持久化

---

## 前置要求

- **Node.js >= 20**（必须；用了原生 fetch / `node:fs/promises` 等）
- **npm**（默认；不要换 pnpm / bun，未做兼容测试）
- **git**
- 一个 OpenAI 兼容协议的 LLM 端点 + apiKey（DeepSeek / Qwen / MiMo / 自建均可）

---

## 安装

### 方式 A：从 npm（推荐）

```bash
npm install -g @qxbyte/muse
muse --version
```

> 包名是 `@qxbyte/muse`（scoped），CLI 命令名是 `muse`。需要 Node 20+。

### 方式 B：从源码

```bash
# 1. 拉源码
git clone https://github.com/qxbyte/muse.git
cd muse

# 2. 装依赖
npm install

# 3. 构建（产物在 dist/）
npm run build

# 4. 验证
node ./dist/cli.js --version    # 应输出 0.1.0
node ./dist/cli.js --help

# 5.（可选）全局可用，二选一：
#    A) npm link（推荐）—— 在仓库目录下：
npm link
muse --version

#    B) shell alias —— 仅当前 shell 生效：
echo 'alias muse="node $(pwd)/dist/cli.js"' >> ~/.zshrc
source ~/.zshrc
```

---

## 配置

muse 用**两个文件**分工：

| 文件 | 角色 |
|---|---|
| `~/.muse/models.json` | 模型仓库：你能调用的所有模型 + apiKey |
| `~/.muse/settings.json` | 运行偏好：当前激活哪个 model、UI、权限规则 |

### 1. 建 `~/.muse/models.json`

凭证**强烈推荐**放到 `~/.muse/models.local.json`（自动 gitignore 防误传）或用 `${ENV_VAR}` 占位符。

#### 示例 A：DeepSeek

```bash
mkdir -p ~/.muse
cat > ~/.muse/models.json <<'EOF'
{
  "models": [
    {
      "id": "deepseek-chat",
      "vendor": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "supportsToolCall": true
    },
    {
      "id": "deepseek-reasoner",
      "vendor": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "supportsToolCall": false
    }
  ],
  "availableModels": ["deepseek-chat", "deepseek-reasoner"]
}
EOF

export DEEPSEEK_API_KEY=sk-...   # 写到 ~/.zshrc 持久化
```

#### 示例 B：本地 Ollama

```json
{
  "models": [
    {
      "id": "llama3.1",
      "vendor": "Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "supportsToolCall": true
    }
  ],
  "availableModels": ["llama3.1"]
}
```

本地 endpoint 不需要 apiKey。

#### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 模型唯一标识，自定义；slash 命令引用它 |
| `vendor` | 否 | 厂商名，只在 selector 里显示 |
| `baseUrl` | 是 | OpenAI 兼容协议基址（如 `https://api.deepseek.com/v1`）；也可填 `url` 别名；若误填 `.../chat/completions` 会自动剥后缀 |
| `apiKey` | 否 | 凭证；支持 `${ENV_VAR}` 占位符 |
| `supportsToolCall` | 否 | 工具调用能力，默认 `true` |
| `supportsImages` | 否 | 视觉能力，默认 `false` |
| `contextWindow` | 否 | 上下文窗口大小（tokens），用于 `/cost` 估算 |
| `availableModels` | — | 顶层数组；决定 `/models` selector 里出现哪些 id（不填 = 全部） |

### 2. 建 `~/.muse/settings.json`（首次启动会自动写）

```bash
cat > ~/.muse/settings.json <<'EOF'
{
  "llm": {
    "model": "deepseek-chat"
  },
  "ui": {
    "lang": "zh-CN",
    "showBanner": true
  },
  "permissions": {
    "allow": ["Read", "Grep", "Glob"],
    "ask": ["Write", "Edit", "Bash"],
    "defaultMode": "ask"
  }
}
EOF
```

settings.json 里的 `llm.model` 必须**匹配**某个 models.json 里的 id；`/models` 选中模型后会自动写回这个字段。

### 3. （可选）项目级覆盖

在你工作目录里建 `.muse/settings.json` 或 `.muse/settings.local.json`，对应字段会覆盖全局 settings。`*.local.json` 已被项目 `.gitignore` 忽略，放凭证安全。

---

## 启动

```bash
muse                              # 交互模式（TUI）
muse "总结一下 src/cli.tsx"       # 一次性 prompt 模式
cat bug.log | muse "找出根因"     # 管道输入
muse --debug                      # 详细日志（写到 ~/.muse/logs/<date>.jsonl）
muse --help
```

CLI flag：

| flag | 说明 |
|---|---|
| `-m, --model <id>` | 临时切 model（不写回 settings.json） |
| `-p, --provider <name>` | 临时切 provider（仅 fallback 路径用） |
| `--no-banner` | 不显示启动 banner |
| `--quiet` | 最小输出（隐含 `--no-banner`） |
| `--debug` | 详细日志 |

---

## 内置 Slash 命令

启动后在 TUI 输入 `/` 会自动弹出补全列表，↑↓ 导航，Tab/Enter 补全。

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令 |
| `/clear` | 清空当前会话 |
| `/cost` | 当前会话 token 用量 + 费用估算 |
| `/status` | 模型 / cwd / 历史 / token 综合状态 |
| `/models` | 弹出 selector 切换模型（写回 settings.json + 注入 env） |
| `/config` | 显示 effective 配置（apiKey 脱敏）；`/config reload` 热加载；`/config path` 看路径 |
| `/mcp` | MCP server 状态（v0.1 占位，v0.3 真接） |
| `/compact` | 摘要老消息释放上下文（`--keep N` 保留最近 N 条） |
| `/resume` | ↑↓ 选历史会话加载；带参 `/resume <id-prefix>` 直接加载 |
| `/quit` / `/exit` | 退出 |

---

## 目录结构

```
muse/
  src/
    cli.tsx              # CLI 入口（commander + Ink）
    app.tsx              # Ink 根组件
    components/          # TUI 组件
    llm/                 # LLM 抽象层（providers + pricing）
    loop/                # Agent loop + 上下文压缩
    tools/               # 工具系统 + 内置工具（Read/Write/Edit/Bash/Grep/Glob）
    slash/               # Slash 命令系统
    config/              # 配置加载（settings + models）
    session/             # JSONL 会话持久化
    permission/          # 权限模型（三态 + 4 档 mode）
    mcp/                 # MCP 状态查询（占位）
    log/                 # logger
  dist/                  # 构建产物（不入 git）
```

---

## 凭证安全

- **绝不**把明文 apiKey 写进 `models.json` 之外的文件，更不要写进源码
- 凭证有三种推荐放法（优先级从高到低）：
  1. 环境变量 `${VAR}` 占位符 + shell 配置（最安全，方便 CI）
  2. `~/.muse/models.local.json`（chmod 600；项目级 `*.local.json` 已 gitignore）
  3. `~/.muse/models.json` 明文（仅当你 100% 确定该机器/账号是私有）
- muse 日志里 apiKey 自动脱敏（前 4 + 后 4）
- 切换 model 时，apiKey 注入 `process.env.MUSE_ACTIVE_API_KEY`，业务代码只透过 env 取，不持有副本

---

## 已知限制（v0.1）

- ❌ MCP 协议接入未实现（v0.3 路线图）；`/mcp` 仅显示配置
- ❌ Skill 加载未实现（v0.2）
- ❌ Subagent 未实现（v0.2）
- ❌ Hooks 未实现（v1.0）
- ❌ 自动上下文压缩未实现（`/compact` 手动可用）
- ⚠️ Anthropic provider 未实现（只支持 OpenAI 兼容协议族）
- ⚠️ `--continue` flag 未完整接通
- ⚠️ TUI 输入框历史导航（↑↓ 翻历史）未实现，被 `/models` autocomplete 占用

---

## 路线图

- **v0.1 MVP（当前）**：CLI / LLM / Agent loop / Read/Write/Edit/Bash/Grep/Glob / 权限模型 / Session / 9 个 slash 命令
- **v0.2**：Skill 加载、Slash command 文件加载、Subagent、自动 compact
- **v0.3**：MCP 客户端、Anthropic provider、多 provider 能力矩阵
- **v0.4**：长期 Memory、TodoWrite、单二进制分发
- **v1.0**：Hooks、沙箱（sandbox-exec）、自定义 subagent 类型

---

## 设计文档

宏观设计 / 实现日志 / 子规范在 `CLAUDE.md` 关联的文档库（私有 Obsidian vault），代码注释引用对应章节（如 `// 见 muse-design.md §7.2`）。

---

## 发布到 npm（维护者）

发布完全自动化：在 GitHub 上 publish 一个 release，`.github/workflows/release.yml` 会跑 typecheck + build + `npm publish --provenance`。

### 一次性准备（首次发布前）

1. 在 [npm.com](https://www.npmjs.com/) 注册账号 `qxbyte`（与 GitHub 用户名一致，确保 scope `@qxbyte/` 归属正确）
2. npm.com → 头像菜单 → **Access Tokens** → **Generate New Token** → **Classic** → 选 **Automation**（CI 专用）
3. 复制 token（`npm_...` 开头）
4. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `NPM_TOKEN`
   - Value: 粘贴上一步的 token

### 每次发布

```bash
# 1. 改 package.json 的 version（语义化版本：0.1.0 → 0.1.1 / 0.2.0 / 1.0.0）
npm version patch    # 或 minor / major；这条会自动 commit 并打 tag vX.Y.Z

# 2. 推 commit + tag
git push && git push --tags

# 3. 到 GitHub Releases 页面（https://github.com/qxbyte/muse/releases/new）
#    - Tag: 选刚 push 的 vX.Y.Z
#    - Title: vX.Y.Z
#    - Description: 写改动说明
#    - 点 "Publish release"
```

GitHub Actions 会自动触发，可在 repo Actions 页面看进度。校验 tag 必须与 package.json version 一致（不然 workflow 主动 fail，避免发错版本）。

发布成功后，所有人能用 `npm install -g @qxbyte/muse` 装上。

### 失败排查

- `403 Forbidden`：NPM_TOKEN 失效 / 没权限 publish `@qxbyte/`
- `version already published`：package.json 没 bump，重复发了同 version
- `tag does not match package.json`：tag 是 v0.1.1 但 package.json 还是 0.1.0
- typecheck/build fail：本地先跑 `npm run typecheck && npm run build` 排错再 push

---

## License

MIT
