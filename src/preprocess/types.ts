/**
 * 4 段预处理管线共享类型。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §3.3。
 */

/** stage 执行结果(用于日志/metrics)。 */
export type StageStatus = "ok" | "skip" | "error" | "timeout";

export interface StageReport {
  pipeline: string;
  stage: string;
  durationMs: number;
  status: StageStatus;
  error?: string;
}

export interface PreprocessLogger {
  stage(report: StageReport): void;
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void;
}

/** noop logger:测试与默认接入时不传 logger 也能跑。 */
export const NOOP_LOGGER: PreprocessLogger = {
  stage() {},
  warn() {},
};

export interface PreprocessTelemetry {
  /** stage 累计耗时(毫秒)。 */
  stageDurations: Map<string, number>;
  /** stage 执行次数。 */
  stageInvocations: Map<string, number>;
}

export function createTelemetry(): PreprocessTelemetry {
  return {
    stageDurations: new Map(),
    stageInvocations: new Map(),
  };
}
