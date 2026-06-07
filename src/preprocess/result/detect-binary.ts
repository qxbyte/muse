/**
 * detect-binary:NUL 字节 / 非 ASCII 比例阈值检测,命中替换为占位说明。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.3.2。
 *
 * 阈值:NUL > 0 或 非 ASCII printable > 30%。
 */

import type { PipelineStage } from "../pipeline.js";
import type { ResultCtx } from "./ctx.js";

const SAMPLE_BYTES = 4096;
const NON_ASCII_RATIO = 0.3;

export class DetectBinaryStage implements PipelineStage<ResultCtx> {
  readonly name = "detect-binary";

  skip(ctx: ResultCtx): boolean {
    return ctx.settings.detectBinary?.enabled === false;
  }

  run(ctx: ResultCtx): void {
    const buf = Buffer.from(ctx.content, "utf-8");
    const len = Math.min(buf.byteLength, SAMPLE_BYTES);
    if (len === 0) return;
    let nul = 0;
    let nonPrintable = 0;
    for (let i = 0; i < len; i++) {
      const c = buf[i];
      if (c === 0) nul++;
      else if (c < 0x09 || (c > 0x0d && c < 0x20)) nonPrintable++;
    }
    const ratio = nonPrintable / len;
    if (nul > 0 || ratio > NON_ASCII_RATIO) {
      const reason = nul > 0 ? `contains ${nul} NUL bytes` : `${(ratio * 100).toFixed(1)}% non-printable bytes in sample`;
      ctx.binaryDetected = { reason, bytes: buf.byteLength };
      ctx.content = `[binary content suppressed: ${reason}; ${buf.byteLength} bytes]`;
      ctx.warnings.push({ stage: this.name, message: reason });
    }
  }
}
