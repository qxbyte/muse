# Muse

> 围绕 OpenAI 兼容协议构建的 TypeScript Agent CLI,内建权限管控 + 长期记忆 + 向量召回。一线支持国内 LLM(DeepSeek / Qwen / Kimi / GLM / Ollama / MiMo)。

**v0.2.0 新增**:跨项目 + 项目级双层长期记忆(`/memory` + `/remember`)· `MUSE.md` / `AGENTS.md` 多层 hierarchy · 向量召回(6 个 OpenAI 兼容 preset + 4 个本地 transformers preset,默认关闭) · trust 分级(trusted/verified/auto)· 9 节 compaction schema · 上下文管理升级(用户消息保护 / tool result 自动折叠 / facts 自动 promote 等)。完整配置见 [`docs/操作手册.md`](./docs/操作手册.md)。

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [配置详解](#配置详解)
- [使用](#使用)
- [长期记忆与向量召回](#长期记忆与向量召回)
- [常见问题](#常见问题)
- [License](#license)

---

## 安装

### 方式 A：从 npm（推荐）

```bash
npm install -g @qxbyte/muse
muse --version
```

需要 **Node.js >= 20**。包名 `@qxbyte/muse`（scoped），CLI 命令名 `muse`。

### 方式 B：从源码

```bash
git clone https://github.com/qxbyte/muse.git
cd muse
npm install
npm run build
node ./dist/cli.js --version
```

让命令全局可用：

```bash
# 在仓库目录
npm link
muse --version
```

---

## 快速开始

最少 3 步把 muse 跑起来。

### 1. 准备一个 LLM 端点的 apiKey

任选一个：

| Provider | 申请页 | env 变量名（习惯） |
|---|---|---|
| DeepSeek | https://platform.deepseek.com | `DEEPSEEK_API_KEY` |
| Qwen (阿里百炼) | https://bailian.console.aliyun.com | `DASHSCOPE_API_KEY` |
| Moonshot (Kimi) | https://platform.moonshot.cn | `MOONSHOT_API_KEY` |
| 智谱 GLM | https://open.bigmodel.cn | `ZHIPU_API_KEY` |
| OpenAI | https://platform.openai.com | `OPENAI_API_KEY` |
| Ollama (本地) | https://ollama.com | 不需要 |

### 2. 建模型仓库 `~/.muse/model.local.json`

```bash
mkdir -p ~/.muse
cat > ~/.muse/model.local.json <<'EOF'
{
  "models": [
    {
      "id": "deepseek-chat",
      "vendor": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "supportsToolCall": true
    }
  ],
  "availableModels": ["deepseek-chat"]
}
EOF
chmod 600 ~/.muse/model.local.json
```

> 文件名后缀 `.local.json` 是 muse 的视觉提示——本机本地、从不入 git；明文写 apiKey 是 OK 的。

### 3. 启动

```bash
muse                                # 进交互模式
```

第一次启动会自动写 `~/.muse/settings.json` 记录默认模型；在 TUI 里输入 `/model` 可以切换。

---

## 配置详解

muse 用三个文件：

```
~/.muse/
├── models.local.json     # 模型仓库：你能调用的所有模型 + 凭证（本机本地，从不入 git）
├── settings.json         # 运行偏好：当前激活的 model / UI / 权限
├── settings.local.json   # settings 的本机兜底覆盖
├── sessions/             # 会话 JSONL 历史
└── logs/                 # 日志（运行报错排查用）
```

### 模型仓库：`~/.muse/model.local.json`

完整字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 模型唯一标识，**你自己起的名字**；slash 命令和 settings.json 用它引用 |
| `name` | string | | 显示名，缺省 = id |
| `vendor` | string | | 厂商名，只在 `/model` selector 里分组显示 |
| `baseUrl` | string | ✅ | OpenAI 兼容协议**基址**（如 `https://api.deepseek.com/v1`）；填全 endpoint `.../v1/chat/completions` 也行，会自动剥后缀；别名字段 `url` 等价 |
| `apiKey` | string | | 凭证；可直接写明文（推荐，文件本就只在本机），也支持 `${ENV_VAR}` 占位符；本地 Ollama 等可不填 |
| `supportsToolCall` | bool | | 是否支持 function calling，默认 `true` |
| `supportsImages` | bool | | 是否支持视觉，默认 `false` |
| `contextWindow` | number | | 上下文窗口（tokens），用于 `/cost` 估算 |
| `availableModels` | string[] | | 顶层数组；决定 `/model` selector 里显示哪些 id（不填 = 全部 models） |

### 多 Provider 配置示例

把多个一起放进 `models` 数组，按需在 `availableModels` 里挑：

```json
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
    },
    {
      "id": "qwen-plus",
      "vendor": "Qwen",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "${DASHSCOPE_API_KEY}",
      "supportsToolCall": true
    },
    {
      "id": "kimi-k2",
      "vendor": "Moonshot",
      "baseUrl": "https://api.moonshot.cn/v1",
      "apiKey": "${MOONSHOT_API_KEY}",
      "supportsToolCall": true
    },
    {
      "id": "glm-4-plus",
      "vendor": "GLM",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "${ZHIPU_API_KEY}",
      "supportsToolCall": true
    },
    {
      "id": "gpt-4o-mini",
      "vendor": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "supportsToolCall": true,
      "supportsImages": true
    },
    {
      "id": "llama3.1",
      "vendor": "Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "supportsToolCall": true
    },
    {
      "id": "my-self-hosted",
      "vendor": "Custom",
      "baseUrl": "https://my-vllm-gateway.example.com/v1",
      "apiKey": "${MY_GW_KEY}",
      "supportsToolCall": true
    }
  ],
  "availableModels": [
    "deepseek-chat",
    "deepseek-reasoner",
    "qwen-plus",
    "kimi-k2",
    "glm-4-plus",
    "gpt-4o-mini",
    "llama3.1"
  ]
}
```

### 运行偏好：`~/.muse/settings.json`

```json
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
```

字段：

| 字段 | 说明 |
|---|---|
| `llm.model` | 当前激活的 model id，必须在 models.local.json 的 models 数组里能找到 |
| `ui.lang` | UI 文案语言，`zh-CN` / `en` |
| `ui.showBanner` | 启动是否显示彩虹 banner |
| `permissions.allow` | 直接放行的工具名列表（如 `Read`、`Bash(npm:*)`） |
| `permissions.ask` | 调用前要 y/n 确认的工具 |
| `permissions.deny` | 永远拒绝的工具 |
| `permissions.defaultMode` | `strict`（未匹配 → ask）、`relaxed`（未匹配 → allow）、`ask`（默认） |

> 用 `/model` 切换模型时，muse 会自动写回 `llm.model`，**不需要手动改**。

### 凭证安全

`~/.muse/model.local.json` 是凭证唯一落脚点。两种写法：

1. **直接写明文**（推荐——文件本就只存在于本机）
   ```json
   { "apiKey": "sk-..." }
   ```
   - 文件名带 `.local.json`，约定**绝不入 git**
   - 建议 `chmod 600 ~/.muse/model.local.json`
   - 警惕同步盘（iCloud / Dropbox）：如果 `~/.muse/` 被同步盘覆盖，凭证会扩散

2. **`${VAR}` 占位符 + shell env**（怕同步盘扩散时用）
   ```bash
   # ~/.zshrc 或 ~/.bashrc
   export DEEPSEEK_API_KEY=sk-...
   ```
   ```json
   { "apiKey": "${DEEPSEEK_API_KEY}" }
   ```
   muse 启动时自动展开。如果 env 没设，会给出指明缺哪个变量的友好报错。

muse 自身的安全保证：
- 日志里 apiKey **自动脱敏**（前 4 + 后 4，中间打码）
- 切换 model 时 apiKey 注入 `process.env.MUSE_ACTIVE_API_KEY`，业务代码只透过 env 取，不持有副本
- 进程退出后 env 不残留，不污染你的 shell

### 配置文件加载优先级

由低到高（高的覆盖低的）：

1. 内置默认值
2. `~/.muse/settings.json`（全局共享）
3. `<项目>/.muse/settings.json`（项目级，可入 git）
4. `<项目>/.muse/settings.local.json`（项目级，已 gitignore）
5. 环境变量 `MUSE_PROVIDER` / `MUSE_MODEL`
6. CLI flags `-p` / `-m`

`models.local.json` 只有 `~/.muse/` 层，无项目级（模型仓库本质是 user-level）。

---

## 使用

### 启动方式

```bash
muse                                      # 交互模式（TUI）
muse "总结一下 src/cli.tsx"               # 一次性 prompt
cat bug.log | muse "找出根因"             # 管道输入
muse --quiet "..."                        # 最小输出，适合脚本
muse --debug                              # 详细日志到 ~/.muse/logs/<date>.jsonl
muse --help
```

### CLI 参数

| flag | 说明 |
|---|---|
| `-m, --model <id>` | 临时切 model（不写回 settings.json） |
| `-p, --provider <name>` | 临时切 provider（仅 fallback 路径用） |
| `--no-banner` | 不显示启动 banner |
| `--quiet` | 最小输出（隐含 `--no-banner`） |
| `--debug` | 详细日志 |
| `--continue` | 恢复上次会话（部分实现） |
| `-v, --version` | 打印版本 |
| `-h, --help` | 打印帮助 |

### Slash 命令

启动后在 TUI 输入 `/` 会弹出补全列表,↑↓ 导航,Tab/Enter 接受。`/help` 输出按分类分组 + 按键提示。

| 命令 | 作用 |
|---|---|
| `/help` | 列所有命令(按分类分组)+ 按键速查表 |
| `/clear` | 清空当前会话 |
| `/cost` | 当前会话 token 用量 + 费用估算 |
| `/model` | 弹出 selector,↑↓ 选模型(自动写回 settings.json) |
| `/config [reload\|path]` | 显示 effective 配置 / 热加载 / 列配置文件路径 |
| `/compact [--keep N]` | 摘要老消息释放上下文(9 节结构化 schema + facts 自动 promote 到 memory) |
| `/memory [子命令]` | 长期记忆管理(详见 [`docs/操作手册.md`](./docs/操作手册.md) §4.3)<br>`list` / `view <name>` / `edit <name>` / `delete <name>` / `promote <name>` / `promote-scope <name>` / `trust <name> <level>` / `search <query>` / `diff` / `diagnose` |
| `/remember [--user\|--project] <text>` | 用户显式存记忆 — LLM 把口语化文本抽取成结构化 memory(默认 user 跨项目) |
| `/btw <question>` | 旁白问答:浮层显示,**不**进历史 |
| `/resume` | ↑↓ 选历史会话加载;带参 `/resume <id-prefix>` 直接加载 |
| `/mcp` | MCP server 状态(预留,v0.3 落地) |
| `/mode [<mode>]` | 切权限模式(default / acceptEdits / plan / bypassPermissions) |
| `/exit` | 退出 |

### 内置工具

LLM 在执行任务时可调用:

| 工具 | 作用 |
|---|---|
| `Read` | 读文件,支持 offset / limit 分页 |
| `Write` | 写文件(必须先 Read 过才能 Write,防误覆盖) |
| `Edit` | 精确字符串替换(比全文重写省 token) |
| `Grep` | ripgrep 包装 |
| `Glob` | 文件匹配 |
| `Bash` | 执行 shell 命令;危险命令(rm -rf / sudo / curl…\|sh)硬拒绝 |
| `WebFetch` | 抓取 URL → markdown(SSRF 防护 + http→https + 30s + 1MB) |
| `TodoWrite` | 任务清单(session 内),固定显示在输入框上方 |
| `MemoryRead` | 读单条长期 memory(`MEMORY.md` 索引行自动注入 system prompt) |
| `MemoryWrite` | 写长期 memory(支持 `scope: "project" \| "user"` 双层) |
| `AskUserQuestion` | 弹结构化 picker 同步问用户(单 / 多选 + Notes) |

所有写操作 / Bash 默认走权限弹窗(y/n 确认),权限模式可调(见下)。

### 权限模式（Shift+Tab 循环）

底部状态栏显示当前模式：

| 模式 | 行为 | 何时用 |
|---|---|---|
| `default` | 按 settings.permissions 规则判定 | 日常 |
| `acceptEdits` | Edit / Write 自动放行，其他不变 | 信任的批量改 |
| `plan` | 只允许只读工具（Read / Grep / Glob），让 LLM"想清楚再动手" | 探索代码、定方案 |
| `bypassPermissions` | 除 deny 列表与硬拒绝命令外全部放行 | 沙箱环境、CI |

按 `Shift+Tab` 在四档间循环；不持久化，重启回到 default。

### 切换模型

两种方式：

1. **TUI 内**：输入 `/model` → ↑↓ 选 → Enter，自动写回 settings.json + 注入 env
2. **命令行临时**：`muse -m kimi-k2 "..."`（不持久化）
3. **手动编辑**：改 `~/.muse/settings.json` 里的 `llm.model`，TUI 里 `/config reload` 热加载

### Markdown 渲染

assistant 回复里的 markdown(标题、列表、代码块、表格、链接)会被渲染成富文本。流式输出过程中是纯文本,本轮结束后自动替换成格式化版本。

---

## 长期记忆与向量召回

v0.2.0 新增。`/memory` 命令族管理跨 session 持久化记忆;`/remember` 是用户显式入口。

**两层独立存储 + 合并召回**:

| scope | 路径 | 用途 |
|---|---|---|
| `project` | `~/.muse/projects/<hash>/memory/` | 项目专属(团队约定 / 项目 bug 修复 / 架构决策) |
| `user` | `~/.muse/memory/` | 跨项目用户级(编辑器偏好 / 工作语言 / 工具偏好) |

召回时两层合并,**项目优先**(同分时 project 排前)。trust 分级:`trusted`(`MUSE.md`/`AGENTS.md`,硬约束)/ `verified`(用户编辑过)/ `auto`(LLM 自动写,可被新证据覆盖)。

**`MUSE.md` / `AGENTS.md` hierarchy**:5 层 — `~/.muse/MUSE.md`(全局)→ `<project>/MUSE.md`(团队)→ `<project>/.muse/MUSE.local.md`(个人本地)→ 子目录惰性加载。`AGENTS.md` 兼容读取(跨工具事实标准)。

**向量召回**(默认关闭,启用一行配置):

```jsonc
// ~/.muse/settings.local.json
{
  "memory": {
    "embedding": {
      "enabled": true,
      "preset": "dashscope-v3",          // 阿里 DashScope(国内直连,推荐中文场景)
      "apiKey": "${DASHSCOPE_API_KEY}"
    }
  }
}
```

支持的 preset:
- **云端 OpenAI 协议**:`dashscope-v3`(阿里 1024-dim)/ `zhipu-3`(智谱 2048-dim)/ `openai-3-small`(1536-dim) / `openai-3-large`(3072-dim)/ `ollama-nomic` / `ollama-bge-m3`(本地零成本)
- **本地 transformers**(需先 `npm i -g @huggingface/transformers`):`local-bge-zh` / `local-bge-en` / `local-minilm` / `local-bge-m3`

**配置失败永不阻塞** — 自动降级到 `hash-bag`(本地零依赖) → 全文模式(`MEMORY.md` 索引前 200 行注入)。`muse` 内跑 `/memory diagnose` 看状态 + 修复建议。

完整章节见 [`docs/操作手册.md`](./docs/操作手册.md) §3.7 / §4.3 / §4.4 / §9.7。

---

## 常见问题

### `/model` 显示 "No models registry found"

`~/.muse/model.local.json` 不存在或解析失败。

- 路径是否正确？`ls ~/.muse/model.local.json`
- JSON 格式是否合法？`jq . ~/.muse/model.local.json`
- 字段错位？看 `~/.muse/logs/<today>.jsonl` 里的 warn

### `Model "..." needs an API key but none was found`

启动时 apiKey 没注入到 env。muse 会直接告诉你根因 + 修复方式（缺哪个 env var、改哪个文件）。看报错头几行即可。

如果用了 `${ENV_VAR}` 占位符且 env 没 export，最快修复是直接把明文 key 填进 `~/.muse/model.local.json`（文件就在本机，明文 OK）。

### 启动时一段 zod warn JSON

`~/.muse/settings.json` 字段不匹配 schema。看 warn 里的 `path` 列就知道哪个字段错了，照着改。

### Ollama 本地模型连不上

- Ollama 服务跑没？`curl http://localhost:11434/api/tags`
- `baseUrl` 必须填 `http://localhost:11434/v1`（带 `/v1`），不能只填 host
- 防火墙 / 端口被占用？

### 国产 provider 工具调用失败

部分国产 provider 对 OpenAI function calling 协议的实现有小差异。如果 LLM 看起来"忽略工具"或"乱调"：

- 试着把 `supportsToolCall` 改成 `false` 强行降级到纯对话
- 切到 DeepSeek / Qwen / Moonshot 等兼容性较好的 provider 验证
- 查 `~/.muse/logs/<today>.jsonl` 看 LLM 实际响应内容

### 想要恢复昨天的会话

```
muse           # 进 TUI
/resume        # ↑↓ 选 → Enter
```

会话存在 `~/.muse/sessions/<project-hash>/<uuid>.jsonl`，按 cwd 分目录。

### 如何卸载

```bash
npm uninstall -g @qxbyte/muse
rm -rf ~/.muse                            # 清配置 / 会话 / 日志(可选)
```

### 启用 embedding 后召回不准 / 启动报错

在 muse 里跑 `/memory diagnose`,会显示:
- 当前 embedding 配置(preset / model / apiKey 是否设)
- 索引文件状态(每 scope 的 `.index.json` 是否存在)
- Live probe 结果(✓ / ✗ HTTP 错)
- 按错误类型分类的修复建议

任何失败都自动降级到 hash-bag / 全文模式,muse 永远可用。

---

## 更多文档

- [`docs/操作手册.md`](./docs/操作手册.md) — 完整配置 / 命令参考 / 三套 embedding 启用清单(阿里 / OpenAI / Ollama)/ FAQ
- [`CHANGELOG`](https://github.com/qxbyte/muse/releases) — 各版本变更

---

## License

MIT
