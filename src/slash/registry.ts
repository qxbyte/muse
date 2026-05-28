/**
 * Slash 命令注册表与解析器。
 */

import type { SlashCommand } from "./types.js";

export class SlashRegistry {
  private byName = new Map<string, SlashCommand>();
  private order: SlashCommand[] = [];

  register(cmd: SlashCommand): void {
    if (this.byName.has(cmd.name)) {
      throw new Error(`Duplicate slash command: /${cmd.name}`);
    }
    this.byName.set(cmd.name, cmd);
    this.order.push(cmd);
    for (const a of cmd.aliases ?? []) {
      if (!this.byName.has(a)) this.byName.set(a, cmd);
    }
  }

  registerAll(cmds: SlashCommand[]): void {
    for (const c of cmds) this.register(c);
  }

  get(name: string): SlashCommand | undefined {
    return this.byName.get(name);
  }

  list(): SlashCommand[] {
    return [...this.order];
  }
}

export interface ParsedSlash {
  name: string;
  args: string;
}

/** "/foo bar baz" → { name: "foo", args: "bar baz" }；非 slash 返回 null。 */
export function parseSlash(input: string): ParsedSlash | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { name: body, args: "" };
  return { name: body.slice(0, space), args: body.slice(space + 1).trim() };
}
