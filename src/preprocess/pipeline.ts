/**
 * 统一 Pipeline 抽象。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §2.1。
 *
 * 4 段管线(Input/Request/Result/Render)共享同一套框架。
 * stage 顺序执行 + 可变 ctx;单 stage 失败可配 throw / skip 容忍。
 */

import { NOOP_LOGGER, type PreprocessLogger, type StageStatus, type StageReport } from "./types.js";

/** Pipeline 短路信号:抛出后 pipeline 立即停止,剩余 stage 跳过。 */
export class PipelineShortCircuit extends Error {
  constructor(public readonly reason: string) {
    super(`pipeline short-circuit: ${reason}`);
    this.name = "PipelineShortCircuit";
  }
}

/** Hook 阻断信号:用户配置的 hook 命令返回 block 时,pipeline 应转换为此错误向上抛。 */
export class PipelineBlockedError extends Error {
  constructor(public readonly point: string, public readonly reason: string) {
    super(`blocked at ${point}: ${reason}`);
    this.name = "PipelineBlockedError";
  }
}

export interface PipelineStage<Ctx> {
  /** stage 名,唯一,kebab-case;用于日志、disable 列表。 */
  readonly name: string;
  /** 入参与出参共享同一个可变 ctx;返回 Promise<void> 表示就地修改。 */
  run(ctx: Ctx): Promise<void> | void;
  /** 可选:跳过条件;返回 true 时本 stage 不执行。 */
  skip?(ctx: Ctx): boolean;
}

export interface PipelineRunOptions {
  /** 全局执行超时(毫秒);超时后剩余 stage 跳过并标 timeout。 */
  timeoutMs?: number;
  /** 单 stage 出错策略:"throw"(默认)| "skip"(记日志后跳过)。 */
  onStageError?: "throw" | "skip";
  /** 已禁用的 stage name 列表;来自 settings.preprocess.disable。 */
  disable?: ReadonlyArray<string>;
  /** 结构化日志器。 */
  logger?: PreprocessLogger;
  /** Pipeline 名,用于日志归类(如 "input" / "request")。 */
  pipelineName?: string;
}

export class Pipeline<Ctx> {
  constructor(
    private readonly stages: ReadonlyArray<PipelineStage<Ctx>>,
    private readonly opts: PipelineRunOptions = {},
  ) {}

  /** 按声明顺序执行 stages,逐个写日志。 */
  async run(ctx: Ctx): Promise<void> {
    const logger = this.opts.logger ?? NOOP_LOGGER;
    const pipelineName = this.opts.pipelineName ?? "pipeline";
    const disable = new Set(this.opts.disable ?? []);
    const onStageError = this.opts.onStageError ?? "throw";
    const startWall = Date.now();
    const timeoutMs = this.opts.timeoutMs;

    for (const stage of this.stages) {
      if (timeoutMs != null && Date.now() - startWall >= timeoutMs) {
        report(logger, pipelineName, stage.name, 0, "timeout");
        continue;
      }
      if (disable.has(stage.name)) {
        report(logger, pipelineName, stage.name, 0, "skip");
        continue;
      }
      if (stage.skip?.(ctx)) {
        report(logger, pipelineName, stage.name, 0, "skip");
        continue;
      }

      const t0 = Date.now();
      try {
        await stage.run(ctx);
        report(logger, pipelineName, stage.name, Date.now() - t0, "ok");
      } catch (err) {
        if (err instanceof PipelineShortCircuit) {
          report(logger, pipelineName, stage.name, Date.now() - t0, "ok");
          return;
        }
        if (err instanceof PipelineBlockedError) {
          report(logger, pipelineName, stage.name, Date.now() - t0, "error", err.message);
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        report(logger, pipelineName, stage.name, Date.now() - t0, "error", msg);
        if (onStageError === "throw") throw err;
      }
    }
  }
}

function report(
  logger: PreprocessLogger,
  pipeline: string,
  stage: string,
  durationMs: number,
  status: StageStatus,
  error?: string,
): void {
  const r: StageReport = { pipeline, stage, durationMs, status, ...(error ? { error } : {}) };
  logger.stage(r);
}
