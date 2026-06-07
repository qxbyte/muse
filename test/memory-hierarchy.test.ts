/**
 * II-1 + II-2 hierarchy 加载测试。
 *
 * 5 层中本期实装前 4 层 + 子目录惰性加载入口;子目录 Agent loop 联动留下一阶段。
 *
 * 隔离:每个 test 用 mkdtemp 作为 cwd + 临时 HOME。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHierarchy,
  loadSubdirMemory,
  findProjectRoot,
  formatHierarchyForPrompt,
} from "../src/loop/hierarchy.js";

let originalHome: string | undefined;
let testHome: string;
let projectRoot: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(join(tmpdir(), "muse-home-"));
  projectRoot = await mkdtemp(join(tmpdir(), "muse-proj-"));
  process.env.HOME = testHome;
  // 标记为 project root(.git 目录)
  await mkdir(join(projectRoot, ".git"));
});

afterEach(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(testHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe("II-1 hierarchy 加载", () => {
  it("只有 user 层时,layers = [user]", async () => {
    await mkdir(join(testHome, ".muse"));
    await writeFile(join(testHome, ".muse", "MUSE.md"), "# user prefs\n", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    expect(layers).toHaveLength(1);
    expect(layers[0].level).toBe("user");
    expect(layers[0].source).toBe("MUSE.md");
    expect(layers[0].content).toBe("# user prefs");
    expect(layers[0].trust).toBe("trusted");
  });

  it("user + project,overlay 顺序 user → project", async () => {
    await mkdir(join(testHome, ".muse"));
    await writeFile(join(testHome, ".muse", "MUSE.md"), "user content", "utf-8");
    await writeFile(join(projectRoot, "MUSE.md"), "project content", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    expect(layers.map((l) => l.level)).toEqual(["user", "project"]);
  });

  it("project 层只有 AGENTS.md(无 MUSE.md)时加载 AGENTS.md", async () => {
    await writeFile(join(projectRoot, "AGENTS.md"), "agents content", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    expect(layers).toHaveLength(1);
    expect(layers[0].level).toBe("project");
    expect(layers[0].source).toBe("AGENTS.md");
    expect(layers[0].content).toBe("agents content");
  });

  it("MUSE.md + AGENTS.md 并存时双注入,MUSE.md 在前", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "muse content", "utf-8");
    await writeFile(join(projectRoot, "AGENTS.md"), "agents content", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    expect(layers).toHaveLength(2);
    expect(layers[0].source).toBe("MUSE.md");
    expect(layers[1].source).toBe("AGENTS.md");
  });

  it("ignoreAgentsMd=true 时只读 MUSE.md", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "muse", "utf-8");
    await writeFile(join(projectRoot, "AGENTS.md"), "agents", "utf-8");
    const layers = await loadHierarchy(projectRoot, { ignoreAgentsMd: true });
    expect(layers).toHaveLength(1);
    expect(layers[0].source).toBe("MUSE.md");
  });

  it("local 层(.muse/MUSE.local.md)在 project 之后", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "p", "utf-8");
    await mkdir(join(projectRoot, ".muse"));
    await writeFile(join(projectRoot, ".muse", "MUSE.local.md"), "l", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    const levels = layers.map((l) => l.level);
    expect(levels).toEqual(["project", "local"]);
  });

  it("managed 层默认关闭;enableManaged + 指定 path 时加载", async () => {
    const managedPath = join(testHome, "managed-muse.md");
    await writeFile(managedPath, "managed content", "utf-8");

    // 默认关闭
    const layersDefault = await loadHierarchy(projectRoot);
    expect(layersDefault.filter((l) => l.level === "managed")).toHaveLength(0);

    // 显式启用
    const layersEnabled = await loadHierarchy(projectRoot, { enableManaged: true, managedPath });
    expect(layersEnabled[0].level).toBe("managed");
    expect(layersEnabled[0].content).toBe("managed content");
  });

  it("空文件 / 不存在 → skip,不抛错", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "   \n   ", "utf-8"); // 仅空白
    const layers = await loadHierarchy(projectRoot);
    expect(layers).toHaveLength(0);
  });
});

describe("findProjectRoot", () => {
  it("cwd 含 .git → 返回 cwd", () => {
    expect(findProjectRoot(projectRoot)).toBe(projectRoot);
  });

  it("子目录跑 muse 时,向上找到含 .git 的父目录", async () => {
    const sub = join(projectRoot, "src", "components");
    await mkdir(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(projectRoot);
  });

  it("找不到 .git / .muse 时回退 cwd", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "muse-isolated-"));
    try {
      // tmpdir 通常没有 .git/.muse 父目录(macOS /private/var/folders/...)
      // 这里只验证函数能返回某路径,具体值由系统决定
      const root = findProjectRoot(isolated);
      expect(typeof root).toBe("string");
      expect(root.length).toBeGreaterThan(0);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe("formatHierarchyForPrompt", () => {
  it("空 layers 返回空串", () => {
    expect(formatHierarchyForPrompt([])).toBe("");
  });

  it("格式包含 `# Project guidance` + 各层标签", async () => {
    await writeFile(join(projectRoot, "MUSE.md"), "project content", "utf-8");
    const layers = await loadHierarchy(projectRoot);
    const text = formatHierarchyForPrompt(layers);
    expect(text).toContain("# Project guidance");
    expect(text).toContain("[project:");
    expect(text).toContain("project content");
  });
});

describe("II-1 子目录惰性 — loadSubdirMemory", () => {
  it("子目录无文件 → null", async () => {
    const sub = join(projectRoot, "src");
    await mkdir(sub);
    const result = await loadSubdirMemory(sub);
    expect(result).toBeNull();
  });

  it("子目录 MUSE.md → 加载并返 source=MUSE.md", async () => {
    const sub = join(projectRoot, "src");
    await mkdir(sub);
    await writeFile(join(sub, "MUSE.md"), "subdir guidance", "utf-8");
    const result = await loadSubdirMemory(sub);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("MUSE.md");
    expect(result!.content).toBe("subdir guidance");
    expect(result!.truncated).toBe(false);
  });

  it("子目录 AGENTS.md(无 MUSE.md)→ 加载并返 source=AGENTS.md", async () => {
    const sub = join(projectRoot, "src");
    await mkdir(sub);
    await writeFile(join(sub, "AGENTS.md"), "subdir agents guidance", "utf-8");
    const result = await loadSubdirMemory(sub);
    expect(result!.source).toBe("AGENTS.md");
  });

  it("超 sizeCap → truncated=true + 截断标记", async () => {
    const sub = join(projectRoot, "src");
    await mkdir(sub);
    const longText = "x".repeat(6000);
    await writeFile(join(sub, "MUSE.md"), longText, "utf-8");
    const result = await loadSubdirMemory(sub, { sizeCapBytes: 1000 });
    expect(result!.truncated).toBe(true);
    expect(result!.content).toContain("truncated");
    expect(result!.content.length).toBeLessThan(6000);
  });
});
