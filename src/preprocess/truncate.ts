/**
 * 统一截断算法。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §5.1。
 *
 * 默认策略:头 70% + 尾 30%,中间替换为 `... [omitted N bytes] ...`。
 * Why 头+尾:bash/grep 关键信息常在两端(开头声明、末尾错误),纯头部截断会丢错误码。
 */

export interface TruncateConfig {
  /** 字节预算(默认 64 × 1024)。 */
  budgetBytes?: number;
  /** 触发后保留头/尾的字节比例(默认 0.7 / 0.3)。 */
  headTailRatio?: [number, number];
  /** 截断 marker 文本工厂。 */
  marker?: (omitted: number) => string;
  /** 行边界对齐(默认 true,不切坏行)。 */
  alignToLine?: boolean;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  /** 被丢弃的字节数(按 utf-8 编码计)。 */
  omittedBytes: number;
}

const DEFAULT_BUDGET = 64 * 1024;
const DEFAULT_RATIO: [number, number] = [0.7, 0.3];
const DEFAULT_MARKER = (omitted: number) => `\n... [omitted ${omitted.toLocaleString()} bytes] ...\n`;

export function truncate(content: string, cfg: TruncateConfig = {}): TruncateResult {
  const budget = cfg.budgetBytes ?? DEFAULT_BUDGET;
  const [headRatio, tailRatio] = cfg.headTailRatio ?? DEFAULT_RATIO;
  const marker = cfg.marker ?? DEFAULT_MARKER;
  const alignToLine = cfg.alignToLine ?? true;

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= budget) {
    return { content, truncated: false, omittedBytes: 0 };
  }

  const markerStr = marker(bytes - budget);
  const markerBytes = Buffer.byteLength(markerStr, "utf-8");
  const available = Math.max(1024, budget - markerBytes);
  const headBudget = Math.floor(available * headRatio);
  const tailBudget = available - headBudget;

  let head = takePrefix(content, headBudget);
  let tail = takeSuffix(content, tailBudget);

  if (alignToLine) {
    const lastNL = head.lastIndexOf("\n");
    if (lastNL > headBudget * 0.5) head = head.slice(0, lastNL + 1);
    const firstNL = tail.indexOf("\n");
    if (firstNL >= 0 && firstNL < tail.length * 0.5) tail = tail.slice(firstNL);
  }

  const omitted = bytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8");
  return {
    content: head + marker(Math.max(omitted, 0)) + tail,
    truncated: true,
    omittedBytes: Math.max(omitted, 0),
  };
}

/** 按字节预算从前往后取,不切坏 utf-8 多字节字符。 */
function takePrefix(s: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= bytes) return s;
  // 找一个不切坏 utf-8 的边界:回退到上一字符
  let cut = bytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf-8");
}

/** 按字节预算从后往前取。 */
function takeSuffix(s: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= bytes) return s;
  let cut = buf.byteLength - bytes;
  while (cut < buf.byteLength && (buf[cut] & 0xc0) === 0x80) cut++;
  return buf.subarray(cut).toString("utf-8");
}
