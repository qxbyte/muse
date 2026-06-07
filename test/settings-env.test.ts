import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/config/index.js";

let workdir: string;
let fakeHome: string;
let savedHome: string | undefined;
const KEYS = ["MUSE_DISABLE_CURSOR_BLINK", "MUSE_TEST_INJECT_A", "MUSE_TEST_INJECT_B"];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "muse-env-"));
  mkdirSync(join(workdir, ".muse"), { recursive: true });
  // 把 HOME 指向空目录,隔离用户真实 ~/.muse/settings.json 的 env 注入
  fakeHome = mkdtempSync(join(tmpdir(), "muse-fakehome-"));
  savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  for (const k of KEYS) delete process.env[k];
});

describe("settings.env injection", () => {
  it("settings.env values are written into process.env", async () => {
    writeFileSync(
      join(workdir, ".muse", "settings.json"),
      JSON.stringify({
        env: { MUSE_TEST_INJECT_A: "hello", MUSE_TEST_INJECT_B: "world" },
      }),
    );
    const { settings } = await loadSettings(workdir);
    expect(settings.env).toEqual({ MUSE_TEST_INJECT_A: "hello", MUSE_TEST_INJECT_B: "world" });
    expect(process.env.MUSE_TEST_INJECT_A).toBe("hello");
    expect(process.env.MUSE_TEST_INJECT_B).toBe("world");
  });

  it("existing process.env wins (shell / CLI 优先)", async () => {
    process.env.MUSE_TEST_INJECT_A = "from-shell";
    writeFileSync(
      join(workdir, ".muse", "settings.json"),
      JSON.stringify({ env: { MUSE_TEST_INJECT_A: "from-settings" } }),
    );
    await loadSettings(workdir);
    expect(process.env.MUSE_TEST_INJECT_A).toBe("from-shell");
  });

  it("MUSE_DISABLE_CURSOR_BLINK=1 propagates to process.env", async () => {
    writeFileSync(
      join(workdir, ".muse", "settings.json"),
      JSON.stringify({ env: { MUSE_DISABLE_CURSOR_BLINK: "1" } }),
    );
    await loadSettings(workdir);
    expect(process.env.MUSE_DISABLE_CURSOR_BLINK).toBe("1");
  });

  it("no env field → process.env unchanged", async () => {
    writeFileSync(join(workdir, ".muse", "settings.json"), JSON.stringify({}));
    await loadSettings(workdir);
    expect(process.env.MUSE_DISABLE_CURSOR_BLINK).toBeUndefined();
  });

  it("non-string values fail zod validation and the whole file is ignored", async () => {
    writeFileSync(
      join(workdir, ".muse", "settings.json"),
      JSON.stringify({ env: { MUSE_DISABLE_CURSOR_BLINK: 1 } }),
    );
    await loadSettings(workdir);
    // 整份 settings 被 zod 拒,env 不应被注入
    expect(process.env.MUSE_DISABLE_CURSOR_BLINK).toBeUndefined();
  });
});
