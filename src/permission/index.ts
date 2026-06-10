/**
 * 权限模型：三态 allow / ask / deny，叠加 4 档 PermissionMode。
 *
 * 模式匹配（pattern）：
 *   - "ToolName" 精确匹配
 *   - "Bash(<prefix>)" 匹配 Bash 工具 + 命令前缀
 *   - "Bash(<prefix>:*)" 通配
 *
 * PermissionMode（详见文档库 permission-modes.md）：
 *   - default：完全走 settings.permissions 规则
 *   - acceptEdits：Edit/Write 自动 allow，其他走 default
 *   - plan：只允许 read 类工具，其他全 deny
 *   - bypassPermissions：除显式 deny 与 Bash 硬 deny 外全 allow
 *
 * 危险操作（rm -rf / sudo 等）由 Bash 工具内部 HARD_DENY_PATTERNS 兜底，所有模式都不可绕过。
 */

import type { Permissions } from "../config/types.js";
import type { PermissionLevel } from "../tools/types.js";

export type Decision = "allow" | "ask" | "deny";

/** 用户对 PermissionPrompt 三档选择。 */
export type PermissionDecision = "yes" | "session_allow" | "no";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export const MODE_CYCLE: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default permissions on",
  acceptEdits: "accept edits on",
  plan: "plan mode on",
  bypassPermissions: "bypass permissions on",
};

export const MODE_COLOR: Record<PermissionMode, string> = {
  default: "gray",
  acceptEdits: "#EAB308",
  plan: "#06B6D4",
  bypassPermissions: "#EF4444",
};

export interface PermissionInput {
  toolName: string;
  args: unknown;
  /** Tool 的权限级别；由 Agent loop 从 ToolRegistry 注入。Plan 模式用此区分 read/write。 */
  permission?: PermissionLevel;
}

export class PermissionGate {
  private rules: Required<Permissions>;
  private mode: PermissionMode = "default";
  /** Session 级 allow：用户在 PermissionPrompt 选 "yes, for session" 后填充。 */
  private sessionAllow = new Set<string>();
  /**
   * Skill 临时白名单(扩展接入口 §五.8)。
   * skill 激活时调 pushSkillContext({skillName, allowedTools}),
   * 期内 PermissionGate.decide 对不在白名单的工具直接 deny。
   * 用栈:嵌套激活时 outer skill 失效,inner 收回时恢复。
   */
  private skillContextStack: { skillName: string; allowedTools: Set<string> }[] = [];

  constructor(rules: Permissions = {}) {
    this.rules = {
      allow: rules.allow ?? [],
      ask: rules.ask ?? [],
      deny: rules.deny ?? [],
      defaultMode: rules.defaultMode ?? "ask",
    };
  }

  /** Skill 激活时调;allowedTools 不传或空数组视为不限制。 */
  pushSkillContext(skillName: string, allowedTools?: string[]): void {
    this.skillContextStack.push({
      skillName,
      allowedTools: new Set(allowedTools ?? []),
    });
  }

  /** Skill 解激活时调(LIFO);name 不匹配栈顶时记 warn 但仍 pop 兜底。 */
  popSkillContext(skillName: string): void {
    if (this.skillContextStack.length === 0) return;
    const top = this.skillContextStack[this.skillContextStack.length - 1];
    if (top.skillName !== skillName) {
      // 嵌套不平衡;保守 pop 栈顶
    }
    this.skillContextStack.pop();
  }

  /** 当前激活的 skill name 列表(栈顶在末)。 */
  activeSkills(): string[] {
    return this.skillContextStack.map((c) => c.skillName);
  }

  /** 当前 skill 上下文是否禁止此工具(栈顶为准;白名单空或工具在内 → 允许)。 */
  private deniedBySkillContext(toolName: string): boolean {
    if (this.skillContextStack.length === 0) return false;
    const top = this.skillContextStack[this.skillContextStack.length - 1];
    if (top.allowedTools.size === 0) return false; // 不限制
    return !top.allowedTools.has(toolName);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  cycleMode(): PermissionMode {
    const i = MODE_CYCLE.indexOf(this.mode);
    this.mode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
    return this.mode;
  }

  /** 用户在 PermissionPrompt 选 "yes, allow for session" 时记下。 */
  allowForSession(toolName: string): void {
    this.sessionAllow.add(toolName);
  }

  isSessionAllowed(toolName: string): boolean {
    return this.sessionAllow.has(toolName);
  }

  decide(input: PermissionInput): Decision {
    // 用户显式 deny 永远生效，所有模式不可绕过
    if (this.matches(this.rules.deny, input)) return "deny";
    // Skill 白名单(扩展接入口 §五.8):激活期工具不在 allowed-tools 内 → deny
    // 位置:在 deny 之后(用户 deny 仍最高优先)、session_allow 之前(skill 不能被 session 绕过)
    if (this.deniedBySkillContext(input.toolName)) return "deny";
    // session 级 allow 在 deny 之后、mode 分支之前生效
    if (this.sessionAllow.has(input.toolName)) return "allow";

    switch (this.mode) {
      case "bypassPermissions":
        return "allow";

      case "plan":
        // 只允许只读工具；写/执行/网络类直接 deny
        return input.permission === "read" ? "allow" : "deny";

      case "acceptEdits":
        if (input.toolName === "Edit" || input.toolName === "Write") return "allow";
        return this.defaultDecide(input);

      case "default":
      default:
        return this.defaultDecide(input);
    }
  }

  private defaultDecide(input: PermissionInput): Decision {
    if (this.matches(this.rules.allow, input)) return "allow";
    if (this.matches(this.rules.ask, input)) return "ask";
    switch (this.rules.defaultMode) {
      case "strict":
        return "ask";
      case "relaxed":
        return "allow";
      case "ask":
      default:
        return "ask";
    }
  }

  private matches(patterns: string[], input: PermissionInput): boolean {
    for (const pattern of patterns) {
      if (this.matchOne(pattern, input)) return true;
    }
    return false;
  }

  private matchOne(pattern: string, input: PermissionInput): boolean {
    // "ToolName" 精确匹配
    if (!pattern.includes("(")) {
      return pattern === input.toolName;
    }
    // "Bash(<prefix>:*)" 形式
    const m = pattern.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)$/);
    if (!m) return false;
    const [, toolName, sub] = m;
    if (toolName !== input.toolName) return false;
    if (input.toolName === "Bash" && typeof input.args === "object" && input.args !== null) {
      const cmd = (input.args as { command?: string }).command ?? "";
      if (sub.endsWith(":*")) {
        const prefix = sub.slice(0, -2);
        return cmd.startsWith(prefix);
      }
      return cmd === sub || cmd.startsWith(sub + " ");
    }
    return false;
  }
}
