/**
 * Muse UI 统一色板。
 *
 * 焦点系:所有选择器(Selector / QuestionPicker / SessionSelector / ModelSelector /
 * PermissionPrompt)与补全 overlay(SlashAutocomplete / AtFileAutocomplete)的「焦点行」
 * 共用同色,避免散落硬编码。
 *
 * 后续若做 light / dark 主题切换,改这一文件即可;未来 plugin / mcp 等新选择器
 * 直接 import FOCUS_COLOR,无需再造常量。
 */

/** 焦点行 / 焦点项的整体高亮色 — 命令名 / 文件名 / 选项 label / 边框 ▎。
 *  淡紫色(Tailwind violet-300),对齐 Claude Code Todos 配色风格。 */
export const FOCUS_COLOR = "#C4B5FD";

/** 焦点指针装饰符 `›` 的色 — 默认与 FOCUS_COLOR 同色,留分化空间。 */
export const POINTER_COLOR = FOCUS_COLOR;

/** Todos in_progress 当前进行中任务的高亮色 — 橙色(Tailwind orange-500),
 *  对齐 Claude Code 风格;与 FOCUS_COLOR 分语义:选择器焦点 vs 活跃任务 是两类色。 */
export const ACTIVE_TODO_COLOR = "#F97316";
