/**
 * Logger 包装。第一版用最朴素的 console + 文件追加；后期可替换 pino。
 * Why 不直接用 pino: 简化首版依赖图，等可观测性章节再上 pino。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

class Logger {
  private level: LogLevel = "info";
  private logPath: string;
  private fileEnabled = true;
  /**
   * 是否把 warn/error 同时打到 stderr。**默认 false**,因为 Ink TUI 会捕获 stderr
   * 渲染区,造成 "[error] xxx" 拼接到 PermissionModeBar / footer 等正常 UI 后面的
   * 视觉污染(B-19 修复)。需要 stderr 输出的场景(cli.tsx die / runOneShot)
   * 都已经在用 process.stderr.write 显式打,不依赖 logger。
   *
   * 单元测试 / 后台脚本可显式 setStderrEnabled(true) 开启。
   */
  private stderrEnabled = false;

  constructor() {
    const date = new Date().toISOString().slice(0, 10);
    this.logPath = join(homedir(), ".muse", "logs", `${date}.jsonl`);
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
    } catch {
      this.fileEnabled = false;
    }
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  setStderrEnabled(enabled: boolean) {
    this.stderrEnabled = enabled;
  }

  private write(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...extra,
    };
    if (this.fileEnabled) {
      try {
        appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
      } catch {
        // 落盘失败不阻断主流程
      }
    }
    // 默认不写 stderr,避免污染 Ink TUI 渲染区
    if (this.stderrEnabled && (level === "warn" || level === "error")) {
      const prefix = level === "error" ? "[error]" : "[warn]";
      process.stderr.write(`${prefix} ${msg}\n`);
    }
  }

  trace(msg: string, extra?: Record<string, unknown>) { this.write("trace", msg, extra); }
  debug(msg: string, extra?: Record<string, unknown>) { this.write("debug", msg, extra); }
  info(msg: string, extra?: Record<string, unknown>) { this.write("info", msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>) { this.write("warn", msg, extra); }
  error(msg: string, extra?: Record<string, unknown>) { this.write("error", msg, extra); }
}

export const log = new Logger();

/** API key 脱敏：前 4 后 4，中间打码。 */
export function redactApiKey(key: string | undefined): string {
  if (!key) return "<unset>";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
