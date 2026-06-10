/**
 * Slash 命令系统的核心类型。
 *
 * 设计文档：muse-design.md §7.2 Slash Command。
 *
 * 设计原则：
 * - 命令体只做编排（解析参数、调用 actions、构造 display）
 * - 真正的业务逻辑（压缩、切 LLM、reload 配置、列 session）放在领域模块
 *   （loop/context、mcp/、session/jsonl 等），命令通过 ctx.actions 调
 * - 这样 v0.2 从 .muse/commands/*.md 加载用户命令时，
 *   用户命令也能用同一套 actions 接口
 */

import type { LLMClient } from "../llm/types.js";
import type { Session, SessionSummary } from "../session/jsonl.js";
import type { Message } from "../types/index.js";
import type { Settings } from "../config/types.js";
import type { ModelEntry, ModelsRegistry } from "../config/models.js";
import type { PermissionMode } from "../permission/index.js";

export interface SessionTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 命令可调用的副作用入口。所有"改变 muse 运行时状态"的能力都汇总到这里，
 * 避免命令直接持有 Agent / App state 引用，便于未来用户自定义命令复用。
 */
export interface SlashActions {
  /** 替换 agent 当前消息历史（/clear /compact /resume 用）。 */
  setMessages(messages: Message[]): void;
  /** 按 model id 切换并持久化到 ~/.muse/settings.json llm.model。 */
  switchModel(modelId: string): Promise<void>;
  /** 弹出 ModelSelector 模态，让用户选；resolve 为 null 表示取消。 */
  pickModel(items: ModelEntry[], currentId?: string): Promise<ModelEntry | null>;
  /** 弹出 SessionSelector 模态，让用户选历史会话；resolve 为 null 表示取消。 */
  pickSession(items: SessionSummary[], currentId?: string): Promise<SessionSummary | null>;
  /** 重新加载所有层级的 settings.json + models.local.json，并刷新 LLM / 权限。 */
  reloadSettings(): Promise<{ settings: Settings; sources: string[] }>;
  /** 当前 PermissionMode（用于 /mode 显示）。 */
  getMode(): PermissionMode;
  /** 切换 PermissionMode（用于 /mode <name>）。 */
  setMode(mode: PermissionMode): void;
  /** 显示进度横幅（命令开始长任务时调）。getPercent 由命令侧持有可变 ref。 */
  showProgress(opts: { title: string; tips?: string[]; getPercent?: () => number }): void;
  /** 隐藏进度横幅（命令结束 finally 调）。 */
  hideProgress(): void;
  /**
   * /btw 旁白问答：拉起浮层跑一次无工具 LLM 流，Q & A 都不进 messages。
   * resolve 在用户关闭浮层时调用，命令体可以 await 这个 Promise 后清理。
   */
  askBtw(question: string): Promise<void>;
  /**
   * 在外部编辑器($VISUAL || $EDITOR || vi)中打开文件。
   * Ink TUI 临时让出 TTY 给编辑器,退出后恢复。
   * 编辑器进程退出码 != 0 时 reject。
   */
  openInEditor(filePath: string): Promise<void>;
  /**
   * Skills(扩展接入口 §五.7.2):显式触发 skill,把 body 推入 agent 的 skillState。
   * 返回错误信息(skill 不存在 / hidden)或 null(成功)。
   * 显式调用绕过"text 匹配"路径,disable-model-invocation=true 的也能强制触发。
   */
  activateSkill(name: string): string | null;
}

export interface SlashCommandContext {
  /** 命令名之后的原始参数串，已 trim。 */
  args: string;
  cwd: string;
  llm: LLMClient;
  session: Session;
  settings: Settings;
  settingsSources: string[];
  /** 用户的 models.local.json 仓库；未配置时为 undefined。 */
  modelsRegistry?: ModelsRegistry;
  /** Skills 注册中心(扩展接入口 §五);未启用 skills 时 undefined。 */
  skillRegistry?: import("../skills/types.js").SkillRegistry;
  history: Message[];
  tokens: SessionTokens;
  /** 注入回调：让 /help 等命令能列出全部已注册命令。 */
  listCommands: () => SlashCommand[];
  /** 副作用入口。 */
  actions: SlashActions;
}

export interface SlashCommandResult {
  /** 作为一条 assistant 文本消息追加到历史。 */
  display?: string;
  /** 退出 muse。 */
  exit?: boolean;
}

export interface SlashCommand {
  /** 不带前导 "/"。 */
  name: string;
  description: string;
  /** 同样不带前导 "/"，用于 /exit 之类的别名。 */
  aliases?: string[];
  /** 参数提示（在 /help 里展示）。 */
  argsHint?: string;
  execute(ctx: SlashCommandContext): SlashCommandResult | Promise<SlashCommandResult>;
}
