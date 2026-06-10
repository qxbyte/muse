/**
 * Skills 模块对外汇总 export。
 *
 * 设计文档:模块设计/扩展接入口/设计.md §五。
 *
 * 单一职责:加载 + 解析 + 注入 prompt;触发监听由 src/loop/agent.ts 负责。
 */

export type {
  SkillFile,
  SkillFrontmatter,
  SkillScope,
  SkillRegistry,
  SkillLoadError,
  SkillLoadResult,
} from "./types.js";
export { SkillFrontmatterSchema } from "./types.js";

export { loadSkills, defaultPersonalDir, defaultProjectDir } from "./loader.js";
export type { LoadSkillsOpts } from "./loader.js";

export { parseSkillFile } from "./parser.js";
export type { ParsedSkill } from "./parser.js";

export { renderAvailableSkillsSection, renderActivatedSkillBody } from "./inject.js";

export { detectSkillTriggers } from "./trigger.js";

export {
  createSkillBridgeState,
  activateSkillsFromText,
  resetSkillState,
  appendActivatedSkillBody,
} from "./agent-bridge.js";
export type { SkillBridgeState } from "./agent-bridge.js";
