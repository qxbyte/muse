/**
 * 把已加载的 skill 转成 slash 命令(每个 skill 一条 `/<name>`)。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7(对齐 Claude Code / Codex —
 * skill 既能被模型自决,也能用户用 `/<name>` 显式触发,出现在 `/` 补全菜单)。
 *
 * 规则:
 *   - 命令名默认用 skill name;撞已注册命令(内置 / MCP / 别名)→ 加 `skill:` 前缀
 *     (如 `/skill:deploy`),避免覆盖内置命令。
 *   - 加前缀后仍冲突(极少)→ 跳过该条(用户仍可 `/skill run <name>` 兜底)。
 *   - execute 走 `ctx.actions.activateSkill`(等价 `/skill run`):允许 hidden /
 *     未挂载(glob 未命中)的 skill —— 显式触发不受可见性约束(对齐 CC)。
 */

import type { SlashCommand } from "./types.js";
import type { SkillFile } from "../skills/types.js";

const DESC_MAX = 60;

/**
 * @param skills       已加载 skill(通常 skillRegistry.list())。
 * @param isRegistered 判定命令名是否已被占用(内置 + 别名);调用方传 registry.get 包装。
 */
export function skillsToSlashCommands(
  skills: SkillFile[],
  isRegistered: (name: string) => boolean,
): SlashCommand[] {
  const cmds: SlashCommand[] = [];
  const claimed = new Set<string>();
  const taken = (n: string) => isRegistered(n) || claimed.has(n);
  for (const s of skills) {
    let name = s.name;
    if (taken(name)) name = `skill:${s.name}`;
    if (taken(name)) continue; // 加前缀仍冲突 → 跳过,交给 /skill run 兜底
    claimed.add(name);
    cmds.push(makeSkillCommand(name, s));
  }
  return cmds;
}

function makeSkillCommand(name: string, s: SkillFile): SlashCommand {
  const desc = s.frontmatter.description;
  const short = desc.length > DESC_MAX ? `${desc.slice(0, DESC_MAX - 1)}…` : desc;
  return {
    name,
    description: `[skill:${s.scope}] ${short}`,
    async execute(ctx) {
      const reason = await ctx.actions.activateSkill(s.name);
      return {
        display: reason
          ? `Failed to activate skill "${s.name}": ${reason}`
          : `Skill "${s.name}" activated. Its body will be injected on the next LLM turn.`,
      };
    },
  };
}
