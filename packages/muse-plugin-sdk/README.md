# @qxbyte/muse-plugin-sdk

给 [muse](https://github.com/qxbyte/muse) plugin 作者的类型 + schema 契约。零运行期依赖(`zod` 为 peerDependency)。

## 安装

```bash
npm i -D @qxbyte/muse-plugin-sdk zod
```

## Plugin 结构

```
my-plugin/
├── .muse-plugin/plugin.json     # manifest
├── skills/<name>/SKILL.md        # 声明式:skills(host 自动扫)
├── .mcp.json                     # 声明式:MCP servers
├── hooks/hooks.json              # 声明式:hooks(shell 命令)
└── dist/plugin.js                # 可选:main register(编程式 tools / slash)
```

`.muse-plugin/plugin.json`:

```jsonc
{
  "apiVersion": "1",
  "name": "my-plugin",
  "version": "1.0.0",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json",
  "main": "./dist/plugin.js"
}
```

## 编程式入口(可选)

`skills / mcpServers / hooks` 在 manifest 声明即可,host 自动加载。只有要注册 **tools / slash** 才需要 `main`:

```ts
import type { PluginRegisterFn } from "@qxbyte/muse-plugin-sdk";

const register: PluginRegisterFn = (ctx) => {
  ctx.registerSlash({
    name: "hello",                 // 实际命令为 /my-plugin:hello
    description: "say hi",
    execute: () => ({ display: "hi from my-plugin" }),
  });
  ctx.logger.info("my-plugin registered");
};

export default register;
```

`ctx` 不暴露 `fs` / `env` / `child_process` / `network` —— 外部能力请通过 manifest 的 `mcpServers` 声明(子进程隔离)。

## 分发

通过 marketplace(`.muse-plugin/marketplace.json`)分发,用户:

```
/plugin marketplace add <owner/repo | git-url | path>
/plugin install <my-plugin>@<marketplace>
# 重启 muse 生效
```

详见 muse `模块设计/Plugins/设计.md`。
