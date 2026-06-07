/**
 * Assistant / user 消息的 markdown → ANSI 渲染入口。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.4。
 *
 * 之前散在 `src/components/MessageView.tsx` 内的 marked 初始化与 renderMarkdown
 * 函数集中到这里,作为 RenderPipeline 模块的对外 helper。UI 只 import 这一个入口。
 *
 * marked-terminal 7.x 默认配置 `showSectionPrefix: true`,会在 heading 文本前
 * 显式拼回 `## `,渲染出 `[bold green]## 标题[/]` 的效果 — 即使 heading 颜色生效,
 * 用户视觉上也会看到原始的 `## ` 标记。这里强制关掉。
 */

import chalk from "chalk";
import { marked } from "marked";
// @ts-expect-error marked-terminal 7.x 无内置 .d.ts;运行时正常
import { markedTerminal } from "marked-terminal";

// chalk 在 module load 时可能基于 stdout 探测把 level 锁成 0(非 TTY、CI 等场景),
// 这会让 markedTerminal 的 chalk.bold/italic 全部返回纯文本。Ink 渲染到的目标是 TTY,
// 强制至少 256 色,让 ANSI 码进得了 Text 节点。
if (chalk.level === 0) chalk.level = 3;

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  marked.use(
    markedTerminal({
      // 关键:不要在 heading 文本前拼回 `## `。
      showSectionPrefix: false,
      // 默认 4 空格缩进 list / blockquote,看起来过深 — 跟 Codex 风格对齐:
      // 圆点 + 空格作左边界,续行起点 = 首行文字起点,list 不再额外缩进 4 空格,
      // 用 2 空格只够区分嵌套层级。
      tab: "  ",
    }) as Parameters<typeof marked.use>[0],
  );
  registered = true;
}

/** Markdown → ANSI 字符串。流到一半的 ```code 等会让 parse 抛错,退化到纯文本。 */
export function renderMarkdown(text: string): string {
  ensureRegistered();
  try {
    let out = marked.parse(text) as string;
    out = out.replace(/\n+$/, ""); // 末尾换行去掉,免得 Ink Box 多一行空白

    // 修 marked-terminal 在 list item 等场景里把 **bold** / *italic* 当文本吐出来:
    // 自己用正则补一刀(在 reset 处理之前做,否则 \x1b[0m 会把 \x1b[1m 切断)
    out = out.replace(/\*\*([^\n*]+?)\*\*/g, (_, body) => `\x1b[1m${body}\x1b[22m`);
    out = out.replace(/(?<![*\\\x1b])\*([^\n*]+?)\*(?!\*)/g, (_, body) => `\x1b[3m${body}\x1b[23m`);

    // marked-terminal 在每个 block 前后塞 \x1b[0m 全 reset——这会把外层的
    // chalk.bgHex(用户消息条带)一并清掉,渲染出"字体处没背景"的断带。
    // 整体剥掉,让样式 close 各自的 \x1b[22m / \x1b[23m / \x1b[39m 收尾即可。
    out = out.replace(/\x1b\[0m/g, "");

    // 兜底:LLM 自己写的 markdown 可能用 4-空格缩进表达"代码块"/"突出段落",
    // 即使 marked 不把它解析为 code(语义边界没满足),前导空白仍残留。
    // 把每行前导空白以 4 为单位减半成 2,既保留嵌套层级,又防"过深"。
    out = out.replace(/^( {4,})/gm, (m) => " ".repeat(Math.floor(m.length / 2)));

    return out;
  } catch {
    return text;
  }
}
