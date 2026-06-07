import { describe, it, expect } from "vitest";
import { Pipeline, PipelineShortCircuit, type PipelineStage } from "../../src/preprocess/pipeline.js";
import type { PreprocessLogger, StageReport } from "../../src/preprocess/types.js";

interface Ctx {
  steps: string[];
  value: number;
}

function makeLogger(): { logger: PreprocessLogger; reports: StageReport[] } {
  const reports: StageReport[] = [];
  return {
    reports,
    logger: {
      stage: (r) => reports.push(r),
      warn: () => {},
    },
  };
}

describe("Pipeline", () => {
  it("runs stages in declared order", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: (ctx) => { ctx.steps.push("a"); ctx.value += 1; } },
      { name: "b", run: (ctx) => { ctx.steps.push("b"); ctx.value *= 2; } },
      { name: "c", run: (ctx) => { ctx.steps.push("c"); } },
    ];
    const p = new Pipeline<Ctx>(stages);
    const ctx: Ctx = { steps: [], value: 1 };
    await p.run(ctx);
    expect(ctx.steps).toEqual(["a", "b", "c"]);
    expect(ctx.value).toBe(4);
  });

  it("skips stages whose skip() returns true", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: (ctx) => { ctx.steps.push("a"); }, skip: () => true },
      { name: "b", run: (ctx) => { ctx.steps.push("b"); } },
    ];
    const p = new Pipeline<Ctx>(stages);
    const ctx: Ctx = { steps: [], value: 0 };
    await p.run(ctx);
    expect(ctx.steps).toEqual(["b"]);
  });

  it("skips stages named in disable list", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: (ctx) => { ctx.steps.push("a"); } },
      { name: "b", run: (ctx) => { ctx.steps.push("b"); } },
    ];
    const p = new Pipeline<Ctx>(stages, { disable: ["a"] });
    const ctx: Ctx = { steps: [], value: 0 };
    await p.run(ctx);
    expect(ctx.steps).toEqual(["b"]);
  });

  it("short-circuits when a stage throws PipelineShortCircuit", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: (ctx) => { ctx.steps.push("a"); } },
      { name: "b", run: () => { throw new PipelineShortCircuit("done"); } },
      { name: "c", run: (ctx) => { ctx.steps.push("c"); } },
    ];
    const p = new Pipeline<Ctx>(stages);
    const ctx: Ctx = { steps: [], value: 0 };
    await p.run(ctx);
    expect(ctx.steps).toEqual(["a"]);
  });

  it("onStageError=skip continues on stage error", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: () => { throw new Error("boom"); } },
      { name: "b", run: (ctx) => { ctx.steps.push("b"); } },
    ];
    const p = new Pipeline<Ctx>(stages, { onStageError: "skip" });
    const ctx: Ctx = { steps: [], value: 0 };
    await p.run(ctx);
    expect(ctx.steps).toEqual(["b"]);
  });

  it("onStageError=throw propagates the error", async () => {
    const stages: PipelineStage<Ctx>[] = [
      { name: "a", run: () => { throw new Error("boom"); } },
      { name: "b", run: (ctx) => { ctx.steps.push("b"); } },
    ];
    const p = new Pipeline<Ctx>(stages, { onStageError: "throw" });
    const ctx: Ctx = { steps: [], value: 0 };
    await expect(p.run(ctx)).rejects.toThrow("boom");
  });

  it("logs each stage with status", async () => {
    const { logger, reports } = makeLogger();
    const stages: PipelineStage<Ctx>[] = [
      { name: "ok", run: (ctx) => { ctx.steps.push("ok"); } },
      { name: "skipped", run: () => {}, skip: () => true },
      { name: "err", run: () => { throw new Error("x"); } },
    ];
    const p = new Pipeline<Ctx>(stages, { logger, pipelineName: "test", onStageError: "skip" });
    await p.run({ steps: [], value: 0 });
    expect(reports.map((r) => `${r.stage}:${r.status}`)).toEqual([
      "ok:ok",
      "skipped:skip",
      "err:error",
    ]);
  });
});
