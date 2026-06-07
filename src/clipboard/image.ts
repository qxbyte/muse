/**
 * 从系统剪贴板抓图,落盘 `~/.muse/clipboard/<sha8>.png`。
 *
 * 平台支持:
 *   - macOS:  `pbpaste -Prefer png`(系统自带)
 *   - Linux X11:  `xclip -selection clipboard -t image/png -o`
 *   - Linux Wayland:  `wl-paste --type image/png`
 *   - Windows:  尚未实现(欢迎 PR)
 *
 * 检测顺序:先看平台,再看 PATH 上有没有对应工具。
 */

import { execa, execaSync } from "execa";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log/index.js";

export interface ClipboardImageResult {
  /** 落盘的绝对路径。 */
  path: string;
  bytes: number;
  mediaType: "image/png";
}

/** 抓不到图(剪贴板里不是图片 / 工具不可用)返 null;真正错误抛 Error。 */
export async function grabClipboardImage(): Promise<ClipboardImageResult | null> {
  const buf = await readClipboardImageBytes();
  if (!buf || buf.byteLength === 0) return null;

  const dir = join(homedir(), ".muse", "clipboard");
  await mkdir(dir, { recursive: true });
  const sha8 = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const path = join(dir, `${sha8}.png`);
  await writeFile(path, buf);
  return { path, bytes: buf.byteLength, mediaType: "image/png" };
}

async function readClipboardImageBytes(): Promise<Buffer | null> {
  const plat = platform();
  if (plat === "darwin") {
    return runCaptureBuffer("pbpaste", ["-Prefer", "png"]);
  }
  if (plat === "linux") {
    // 优先 wl-paste (Wayland),回退 xclip
    if (process.env.WAYLAND_DISPLAY) {
      const wl = await runCaptureBuffer("wl-paste", ["--type", "image/png"]);
      if (wl && wl.byteLength > 0) return wl;
    }
    const x = await runCaptureBuffer("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    if (x && x.byteLength > 0) return x;
    return null;
  }
  // Windows / 其他平台
  throw new Error(`Clipboard image read not supported on ${plat} yet.`);
}

/** 跑命令,把 stdout 拿成 Buffer;命令失败(找不到 / 非 0 退出 / 剪贴板没图)统一返 null。 */
async function runCaptureBuffer(cmd: string, args: string[]): Promise<Buffer | null> {
  try {
    const result = await execa(cmd, args, {
      reject: false,
      encoding: "buffer",
      timeout: 5_000,
    });
    if (result.failed) return null;
    const out = result.stdout;
    if (!out) return null;
    if (typeof out === "string") return Buffer.from(out, "binary");
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch {
    return null;
  }
}

/**
 * **同步**抓剪贴板图。用于 Ink useInput 这种不能 await 的回调路径。
 *
 * 实测 macOS `pbpaste -Prefer png` 耗时 ~30-80ms,可接受;同步在主线程阻塞,
 * 但只在 paste 事件触发时跑(用户已经 Cmd+V),不影响日常打字。
 *
 * 返 null 表示剪贴板无图或工具不可用。
 */
export interface ClipboardImageBuffer {
  data: Buffer;
  mediaType: "image/png";
}

export function grabClipboardImageBufferSync(): ClipboardImageBuffer | null {
  const plat = platform();
  if (plat === "darwin") return grabDarwinSync();
  if (plat === "linux") return grabLinuxSync();
  log.debug("clipboard image: unsupported platform", { plat });
  return null;
}

/**
 * macOS 双路径:
 *   1. `pbpaste -Prefer png` — 剪贴板原生就是 PNG 时(浏览器右键复制图等)
 *   2. `osascript ... «class PNGf»` — macOS 截图复制(Cmd+Shift+Ctrl+4)时
 *      底层存的是 NSPasteboardType `public.tiff`,pbpaste 拿不到 PNG;走 osascript
 *      让 macOS 系统自己把任意图像类型转 PNG 落盘临时文件,我们读字节再删
 */
function grabDarwinSync(): ClipboardImageBuffer | null {
  // 路径 1:pbpaste
  let buf = runCaptureBufferSync("pbpaste", ["-Prefer", "png"]);
  if (buf && buf.byteLength > 0 && isPng(buf)) {
    log.debug("clipboard image: OK", { source: "pbpaste", bytes: buf.byteLength });
    return { data: buf, mediaType: "image/png" };
  }
  // 路径 2:osascript
  const tmpPath = join(tmpdir(), `muse-clip-${process.pid}-${Date.now()}.png`);
  try {
    const result = execaSync(
      "osascript",
      [
        "-e", "try",
        "-e", `set p to POSIX file "${tmpPath}"`,
        "-e", "set f to open for access p with write permission",
        "-e", "set eof f to 0",
        "-e", "write (the clipboard as «class PNGf») to f",
        "-e", "close access f",
        "-e", `return "ok"`,
        "-e", "on error errMsg",
        "-e", `return "err:" & errMsg`,
        "-e", "end try",
      ],
      { reject: false, timeout: 5000 },
    );
    const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!out.startsWith("ok") || !existsSync(tmpPath)) {
      log.debug("clipboard image: osascript no PNG", { osa: out, stderr: result.stderr });
      return null;
    }
    buf = readFileSync(tmpPath);
  } catch (err) {
    log.debug("clipboard image: osascript threw", { msg: (err as Error).message });
    return null;
  } finally {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch {}
    }
  }
  if (!buf || buf.byteLength === 0 || !isPng(buf)) {
    log.debug("clipboard image: osascript PNG bad", {
      bytes: buf?.byteLength ?? 0,
      head8: buf ? buf.subarray(0, 8).toString("hex") : "",
    });
    return null;
  }
  log.debug("clipboard image: OK", { source: "osascript", bytes: buf.byteLength });
  return { data: buf, mediaType: "image/png" };
}

function grabLinuxSync(): ClipboardImageBuffer | null {
  let buf: Buffer | null = null;
  let source = "";
  if (process.env.WAYLAND_DISPLAY) {
    source = "wl-paste --type image/png";
    buf = runCaptureBufferSync("wl-paste", ["--type", "image/png"]);
  }
  if (!buf || buf.byteLength === 0) {
    source = "xclip -t image/png -o";
    buf = runCaptureBufferSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  }
  if (!buf || buf.byteLength === 0) {
    log.debug("clipboard image: empty buffer", { source, bytes: 0 });
    return null;
  }
  if (!isPng(buf)) {
    log.debug("clipboard image: not PNG", { source, bytes: buf.byteLength });
    return null;
  }
  log.debug("clipboard image: OK", { source, bytes: buf.byteLength });
  return { data: buf, mediaType: "image/png" };
}

function runCaptureBufferSync(cmd: string, args: string[]): Buffer | null {
  try {
    const result = execaSync(cmd, args, {
      reject: false,
      encoding: "buffer",
      timeout: 5_000,
    });
    if (result.failed) return null;
    const out = result.stdout;
    if (!out) return null;
    if (typeof out === "string") return Buffer.from(out, "binary");
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch {
    return null;
  }
}

/** PNG magic: 89 50 4E 47 0D 0A 1A 0A。pbpaste 没图时返回的空 buffer 或文本 buffer 不会过这道。 */
function isPng(buf: Buffer): boolean {
  if (buf.byteLength < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}
