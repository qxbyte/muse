/**
 * 流式 markdown 拆分:把累计的 streaming text 切成 "stable"(可渲染)+ "unstable"(保留纯文本)。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.4.3。
 *
 * 启发式(不真跑 marked.lexer,因为我们关心的是「断点」而非「token tree」):
 *   1. 找最后一个段落边界 `\n\n`(markdown 里所有 block 都以此分隔)。
 *      - 之前 → stable
 *      - 之后 → unstable(可能是个未完成的段落 / list item / heading)
 *   2. 校验 stable 内 fence(```)行首匹配数为偶数;奇数说明 stable 误切到了未闭合 fence
 *      内部 → 把"最后一个未配对 fence"以及之后整段降级到 unstable
 *   3. inline 标记(**bold** / *italic* / `code`)不做特殊处理;`renderMarkdown` 出错时
 *      已经 try/catch 退回纯文本,代价可接受
 *
 * Why 不用 marked.lexer:
 *   - lexer 单次 ~1-3ms,流式每 16ms 跑一次累积量已大,N 次重复 parse 浪费
 *   - lexer 对未闭合 token 的处理依版本而异,不如硬规则可控
 *   - 我们的目标是「LLM 输出的 prose / list / fence / heading 大概对」,不追求 spec 完美
 */

/** 段落边界正则 — 用懒匹配最后一个 \n\n */
const PARA_BOUNDARY = "\n\n";
/** 行首 fence(三反引号),用作 stable 区域内"奇偶校验"的锚点 */
const FENCE_RE = /^```/gm;

export interface SplitResult {
  /** 已闭合段落,可放心走 renderMarkdown */
  stable: string;
  /** 最后一段未闭合的内容,保留纯文本 */
  unstable: string;
}

export function splitStableUnstable(text: string): SplitResult {
  if (!text) return { stable: "", unstable: "" };

  const lastDoubleNL = text.lastIndexOf(PARA_BOUNDARY);
  if (lastDoubleNL === -1) {
    // 整段还没出现段落边界 → 全是 unstable
    return { stable: "", unstable: text };
  }

  let stable = text.slice(0, lastDoubleNL + PARA_BOUNDARY.length);
  let unstable = text.slice(lastDoubleNL + PARA_BOUNDARY.length);

  // fence 校验:stable 中行首 ``` 个数为奇数时,最后一个 fence 是 open 未 close
  // → 把它之后(含)的整段转给 unstable,等 close 出现再升 stable
  const fences = [...stable.matchAll(FENCE_RE)];
  if (fences.length % 2 === 1) {
    const openIdx = fences[fences.length - 1].index ?? -1;
    if (openIdx >= 0) {
      unstable = stable.slice(openIdx) + unstable;
      stable = stable.slice(0, openIdx);
    }
  }

  return { stable, unstable };
}
