/**
 * 终端标题栏控制（OSC 0/1/2 转义序列）。
 *
 * 用途：在 OS-level tab/window 标题里放一个旋转动画 + 当前状态，
 * 让用户切到别的窗口也能从 dock / taskbar 看出 muse 还在跑（vs 卡死 / 已完成）。
 *
 * 协议：`ESC ] 0 ; <text> BEL` 同时设置 icon name 和 window title——所有主流
 * 终端都认（Terminal.app / iTerm2 / Alacritty / kitty / WezTerm / Windows Terminal）。
 *
 * 安全：非 TTY（管道、CI）和 MUSE_NO_TITLE=1 时静默；title 文本 strip 控制字符
 * 防止注入。
 */

const ENABLED = (() => {
  if (!process.stdout.isTTY) return false;
  if (process.env.MUSE_NO_TITLE === "1") return false;
  return true;
})();

let lastTitle = "";

function sanitize(s: string): string {
  // 删 NUL / BEL / ESC / 其它 C0 控制符——防止用户 cwd 包含恶意字节注入 title
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/** 设标题；与上次完全相同时跳过（减少 stdout 写流量）。 */
export function setTerminalTitle(title: string): void {
  if (!ENABLED) return;
  const clean = sanitize(title);
  if (clean === lastTitle) return;
  lastTitle = clean;
  process.stdout.write(`\x1b]0;${clean}\x07`);
}

/** 清空标题（让终端用默认值）。在进程退出前调一次。 */
export function resetTerminalTitle(): void {
  if (!ENABLED) return;
  lastTitle = "";
  process.stdout.write(`\x1b]0;\x07`);
}
