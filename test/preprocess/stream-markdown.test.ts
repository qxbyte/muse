import { describe, it, expect } from "vitest";
import { splitStableUnstable } from "../../src/preprocess/render/stream-markdown.js";

describe("splitStableUnstable", () => {
  it("empty text → both empty", () => {
    expect(splitStableUnstable("")).toEqual({ stable: "", unstable: "" });
  });

  it("no paragraph boundary → all unstable", () => {
    const t = "still typing";
    expect(splitStableUnstable(t)).toEqual({ stable: "", unstable: t });
  });

  it("single \\n is not a boundary → still all unstable", () => {
    const t = "line one\nline two without double break";
    expect(splitStableUnstable(t)).toEqual({ stable: "", unstable: t });
  });

  it("paragraph boundary splits cleanly", () => {
    const t = "para 1\n\npara 2 in progress";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("para 1\n\n");
    expect(unstable).toBe("para 2 in progress");
  });

  it("multiple paragraph boundaries → last one wins", () => {
    const t = "p1\n\np2\n\np3 wip";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("p1\n\np2\n\n");
    expect(unstable).toBe("p3 wip");
  });

  it("closed fence stays in stable", () => {
    const t = "intro\n\n```ts\nconsole.log(1)\n```\n\ntail wip";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("intro\n\n```ts\nconsole.log(1)\n```\n\n");
    expect(unstable).toBe("tail wip");
  });

  it("unclosed fence inside stable demotes back to unstable", () => {
    // stable 看似 "intro\n\n```ts\nhalf code\n\n" (含 \n\n),但 fence open 未闭合
    // → 把 ```ts 起头之后整段降级
    const t = "intro\n\n```ts\nhalf code\n\nthe second para";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("intro\n\n");
    expect(unstable).toBe("```ts\nhalf code\n\nthe second para");
  });

  it("two closed fences → both stay in stable", () => {
    const t = "```\na\n```\n\n```\nb\n```\n\nwip";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("```\na\n```\n\n```\nb\n```\n\n");
    expect(unstable).toBe("wip");
  });

  it("fence open at unstable tail is not double-counted", () => {
    // 最后一个 \n\n 之后才出现 ```,fence 计数发生在 stable 内,这里 stable 内 0 个 fence
    const t = "para\n\n```ts\nfn(){";
    const { stable, unstable } = splitStableUnstable(t);
    expect(stable).toBe("para\n\n");
    expect(unstable).toBe("```ts\nfn(){");
  });
});
