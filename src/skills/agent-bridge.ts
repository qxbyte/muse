/**
 * Skills ↔ Agent loop 的桥接层。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五.7 / §五.8。
 *
 * 这些函数管 skill 触发 / 激活 / 解激活的运行期状态,以参数式传 agent 持有的
 * 可变集合(activeSkills / activeSkillNames),不依赖 Agent 类内部字段;
 * 抽出来让 agent.ts 单文件保持 ≤ 800 行(CLAUDE.md 硬上限)。
 */

import type { PermissionGate } from "../permission/index.js";
import { detectSkillTriggers } from "./trigger.js";
import { renderActivatedSkillBody } from "./inject.js";
import type { SkillFile, SkillRegistry } from "./types.js";
import { runHooks, type HooksConfig } from "../preprocess/hooks.js";
import { PipelineBlockedError } from "../preprocess/pipeline.js";
import type { PreprocessLogger } from "../preprocess/types.js";

export interface SkillBridgeState {
  /** 已激活的 skill(按触发顺序保 body 拼接稳定)。 */
  activeSkills: SkillFile[];
  /** 同 activeSkills,但 Set 形式给 detect 去重用。 */
  activeSkillNames: Set<string>;
}

/** 创建空状态;agent 每个 instance 持有一份。 */
export function createSkillBridgeState(): SkillBridgeState {
  return { activeSkills: [], activeSkillNames: new Set() };
}

/**
 * 触发 SkillActivate hook(扩展接入口 §五.9)。
 * payload `{ skillName, scope, allowedTools }`,matcher 比 skillName。
 * 返回 null=放行,string=被 hook block 的原因(调用方据此跳过激活 / 报错)。
 * 无 hook 配置 → 直接放行(零开销)。
 */
export async function fireSkillActivateHook(
  skill: SkillFile,
  hooks: HooksConfig | undefined,
  logger?: PreprocessLogger,
): Promise<string | null> {
  if (!hooks?.SkillActivate || hooks.SkillActivate.length === 0) return null;
  try {
    await runHooks(
      "SkillActivate",
      {
        skillName: skill.name,
        scope: skill.scope,
        allowedTools: skill.frontmatter["allowed-tools"] ?? [],
      },
      hooks,
      logger,
    );
    return null;
  } catch (err) {
    if (err instanceof PipelineBlockedError) return err.reason;
    throw err;
  }
}

/**
 * 扫一段 LLM 输出文本,激活新匹配的 skill:
 *   1. detectSkillTriggers 找候选(已激活的 skill 自动跳过)
 *   2. SkillActivate hook(可 block → 跳过该 skill)
 *   3. 加入 state + 推 PermissionGate 临时白名单
 *
 * 无 registry 或空 text → no-op。
 */
export async function activateSkillsFromText(
  text: string,
  registry: SkillRegistry | undefined,
  permissions: PermissionGate,
  state: SkillBridgeState,
  hooks?: HooksConfig,
  logger?: PreprocessLogger,
): Promise<void> {
  if (!registry || !text) return;
  const triggered = detectSkillTriggers(text, registry, state.activeSkillNames);
  for (const s of triggered) {
    const blocked = await fireSkillActivateHook(s, hooks, logger);
    if (blocked) continue;
    state.activeSkills.push(s);
    state.activeSkillNames.add(s.name);
    permissions.pushSkillContext(s.name, s.frontmatter["allowed-tools"]);
  }
}

/**
 * 每轮 user prompt 起始时调:清累计激活的 skill + pop 所有 PermissionGate 临时白名单。
 * 防止上轮 skill 的 allowed-tools 限制本轮新工具调用。
 */
export function resetSkillState(permissions: PermissionGate, state: SkillBridgeState): void {
  for (const s of state.activeSkills) {
    permissions.popSkillContext(s.name);
  }
  state.activeSkills = [];
  state.activeSkillNames.clear();
}

/**
 * 把当前激活的 skill body 拼到 systemPrompt 末尾(易变 tail,cache 不友好但必要)。
 * 空状态 → 返回原 base。
 */
export function appendActivatedSkillBody(base: string, state: SkillBridgeState): string {
  if (state.activeSkills.length === 0) return base;
  const body = renderActivatedSkillBody(state.activeSkills);
  if (!body) return base;
  return base ? `${base}\n\n${body}` : body;
}
