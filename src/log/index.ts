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
    // 仅 warn/error 默认输出到 stderr，避免污染 stdout
    if (level === "warn" || level === "error") {
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
