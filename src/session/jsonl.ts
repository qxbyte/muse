/**
 * Session 持久化：append-only JSONL。
 * 路径：~/.muse/projects/<project-hash>/sessions/<uuid>.jsonl
 *
 * 每行一个事件：消息 / 工具调用 / 工具结果 / 使用统计 / ...
 */

import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message, TokenUsage } from "../types/index.js";
import { log } from "../log/index.js";

export type SessionEvent =
  | { type: "session_start"; time: string; cwd: string; provider: string; model: string }
  | { type: "message"; time: string; message: Message }
  | { type: "usage"; time: string; usage: TokenUsage; provider: string; model: string }
  | { type: "session_end"; time: string; reason: "user_exit" | "error" };

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  path: string;
}

export interface SessionSummary extends SessionMeta {
  /** 首个 user 消息前 60 字符。 */
  preview?: string;
  messageCount: number;
}

function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function sessionsDir(cwd: string): string {
  return join(homedir(), ".muse", "projects", projectHash(cwd), "sessions");
}

export class Session {
  readonly meta: SessionMeta;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(meta: SessionMeta) {
    this.meta = meta;
  }

  static async create(cwd: string): Promise<Session> {
    const id = randomUUID();
    const dir = sessionsDir(cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const meta: SessionMeta = {
      id,
      cwd,
      createdAt: new Date().toISOString(),
      path,
    };
    log.debug("session created", { id, path });
    return new Session(meta);
  }

  static async findLatest(cwd: string): Promise<SessionMeta | undefined> {
    const list = await Session.listAll(cwd, 1);
    return list[0];
  }

  static async resolve(cwd: string, idOrPrefix: string): Promise<SessionMeta | undefined> {
    const dir = sessionsDir(cwd);
    if (!existsSync(dir)) return undefined;
    const entries = await readdir(dir);
    const matches = entries.filter((e) => e.endsWith(".jsonl") && e.startsWith(idOrPrefix));
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(`Ambiguous session id "${idOrPrefix}" matches ${matches.length} sessions; use more characters.`);
    }
    const top = matches[0];
    const st = await stat(join(dir, top));
    return {
      id: top.replace(/\.jsonl$/, ""),
      cwd,
      createdAt: st.mtime.toISOString(),
      path: join(dir, top),
    };
  }

  /**
   * 按修改时间倒序列出当前 cwd 下的 session，附带 preview 与消息数。
   * 读 preview 需要打开每个文件；调用方通过 limit 控制 IO 量。
   */
  static async listAll(cwd: string, limit?: number): Promise<SessionSummary[]> {
    const dir = sessionsDir(cwd);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    const files = entries.filter((e) => e.endsWith(".jsonl"));
    if (files.length === 0) return [];

    const stats = await Promise.all(
      files.map(async (f) => {
        const path = join(dir, f);
        const st = await stat(path);
        return { file: f, path, mtime: st.mtime };
      }),
    );
    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const truncated = typeof limit === "number" ? stats.slice(0, limit) : stats;

    const summaries: SessionSummary[] = [];
    for (const s of truncated) {
      const meta: SessionMeta = {
        id: s.file.replace(/\.jsonl$/, ""),
        cwd,
        createdAt: s.mtime.toISOString(),
        path: s.path,
      };
      const summary = await readSummary(meta);
      summaries.push(summary);
    }
    return summaries;
  }

  static async open(meta: SessionMeta): Promise<{ session: Session; events: SessionEvent[] }> {
    const session = new Session(meta);
    const events = await session.readAll();
    return { session, events };
  }

  /** 从已加载的 events 重建 messages 数组（按时序）。 */
  static messagesFromEvents(events: SessionEvent[]): Message[] {
    const out: Message[] = [];
    for (const ev of events) {
      if (ev.type === "message") out.push(ev.message);
    }
    return out;
  }

  async append(event: SessionEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    // 串行写入避免交错
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.meta.path), { recursive: true });
        await appendFile(this.meta.path, line, "utf-8");
      } catch (err) {
        log.warn(`session append failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.writeQueue;
  }

  async readAll(): Promise<SessionEvent[]> {
    if (!existsSync(this.meta.path)) return [];
    const raw = await readFile(this.meta.path, "utf-8");
    const events: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip corrupt lines
      }
    }
    return events;
  }
}

async function readSummary(meta: SessionMeta): Promise<SessionSummary> {
  let events: SessionEvent[] = [];
  try {
    const raw = await readFile(meta.path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip
      }
    }
  } catch {
    // unreadable; return minimal summary
  }
  const messages = events.filter((e): e is Extract<SessionEvent, { type: "message" }> => e.type === "message");
  const firstUser = messages.find((e) => e.message.role === "user");
  let preview: string | undefined;
  if (firstUser) {
    const c = firstUser.message.content;
    const text = typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    preview = text.slice(0, 60).replace(/\s+/g, " ");
  }
  return { ...meta, preview, messageCount: messages.length };
}
