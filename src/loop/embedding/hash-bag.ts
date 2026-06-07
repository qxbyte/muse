/**
 * Hash-bag embedding(本期默认 provider,零依赖)。
 *
 * 算法:
 *   1. 文本 → 小写 + 词边界 tokenize(英文 + 中文混合按 unicode 字符切)
 *   2. 每个 token 哈希到 dim 维向量的一个 bucket,+1
 *   3. L2 归一化
 *
 * 优劣:
 *   ✓ 跨平台、零 native binding、跨语言可用(中英混合)
 *   ✓ 余弦相似度对"含相同关键词"的文本得分高 → 替代精确 grep 一定程度上有效
 *   ✗ 不懂语义("user prefers tabs" 与 "缩进风格" 不会匹配)
 *
 * 适用场景:memory 文件少(< 100)+ 用户搜索习惯走关键词时;真 embedding 模型在
 * 模糊语义检索上明显更优,通过同接口扩展。
 */

import type { EmbeddingProvider } from "./types.js";

const DEFAULT_DIM = 128;

export class HashBagEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  constructor(dim: number = DEFAULT_DIM) {
    this.dim = dim;
    this.id = `hash-bag-${dim}`;
  }

  async embed(text: string): Promise<number[]> {
    return embedSync(text, this.dim);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedSync(t, this.dim));
  }
}

/** 同步版本(本 provider 无 I/O,实际就是 CPU)。 */
function embedSync(text: string, dim: number): number[] {
  const tokens = tokenize(text);
  const vector = new Array<number>(dim).fill(0);
  for (const token of tokens) {
    const idx = djb2Hash(token) % dim;
    vector[idx] += 1;
  }
  // L2 归一化
  let normSq = 0;
  for (const v of vector) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vector;
  for (let i = 0; i < dim; i++) vector[i] /= norm;
  return vector;
}

/**
 * Tokenize:
 *   - 英文按 \b\w+\b(单词)
 *   - 中文按单字(unicode CJK 范围)
 *   - 数字按词
 *   - 标点 / 空白丢
 *
 * 这样 "用 pnpm 不 npm" 切成 ["用", "pnpm", "不", "npm"] —— 中英混合都覆盖。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  // 用 unicode 属性切:字母 / 数字 / CJK
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const chunk = m[0];
    // CJK 字符单独切;其他作为单词
    if (/[一-鿿]/.test(chunk)) {
      for (const ch of chunk) {
        if (/[一-鿿]/.test(ch)) out.push(ch);
        else out.push(ch);
      }
    } else {
      out.push(chunk);
    }
  }
  return out;
}

/** DJB2 字符串哈希,简单稳定无碰撞偏差。 */
function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  // 32-bit 无符号
  return h >>> 0;
}

/** 余弦相似度(已归一化向量 → dot product)。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
