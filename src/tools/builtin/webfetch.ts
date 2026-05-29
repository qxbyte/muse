/**
 * WebFetch 工具：抓 URL → 文本 / 简易 markdown。
 *
 * 安全：
 *   - 拒绝本机回环 / 链接本地 / 私有网段（SSRF 防护）
 *   - http → https 自动升级
 *   - 30s 超时；最大 1MB 响应体
 *
 * 输出：以 HTML 解析时 strip 标签后近似 markdown；非 HTML 直接返回文本（截断）。
 *
 * 不引入 turndown：v0.1 用 minimal regex 转换，够 LLM 阅读；
 * 后续如需精细 markdown（保留 link / list 嵌套），再换专门库。
 */

import { z } from "zod";
import { defineTool } from "../types.js";

const WebFetchArgs = z.object({
  url: z.string().describe("Fully-qualified URL. http will be upgraded to https."),
  prompt: z
    .string()
    .optional()
    .describe(
      "What information to look for. The host returns the page content; the LLM should then read it to answer the prompt.",
    ),
});

const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^169\.254\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname));
}

export const WebFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch a URL and return its textual content (HTML stripped to a markdown-ish form). " +
    "Use for reading documentation, blog posts, or API specs. Private/loopback hosts are blocked. " +
    "If the URL redirects to a different host, the redirect target is returned for you to re-fetch.",
  parameters: WebFetchArgs,
  permission: "network",
  summarize: (args) => `WebFetch(${args.url})`,
  async execute(args, ctx) {
    let target: URL;
    try {
      target = new URL(args.url);
    } catch {
      return { content: `Invalid URL: ${args.url}`, isError: true };
    }
    if (target.protocol === "http:") {
      target.protocol = "https:";
    }
    if (target.protocol !== "https:") {
      return { content: `Refused: only http(s) URLs are allowed.`, isError: true };
    }
    if (isPrivateHost(target.hostname)) {
      return { content: `Refused: ${target.hostname} is a private/loopback host (SSRF guard).`, isError: true };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.abortSignal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(target.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "muse-cli/0.1" },
      });

      // 跨主机 redirect → 提示重试，不自动跟随
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (loc) {
          try {
            const redirectURL = new URL(loc, target);
            if (redirectURL.hostname !== target.hostname) {
              return {
                content: `Redirect to a different host: ${redirectURL.toString()}\nRe-fetch the new URL explicitly if you trust it.`,
                summary: `Redirect to a different host: ${redirectURL.toString()}`,
                kind: "warn",
              };
            }
            // 同 host redirect 也提示一下，让 LLM 决定是否跟
            return {
              content: `Redirect (same host): ${redirectURL.toString()}\nRe-fetch the new URL to continue.`,
              summary: `Redirect → ${redirectURL.pathname}`,
              kind: "warn",
            };
          } catch {
            return { content: `Redirect with unparseable location: ${loc}`, isError: true };
          }
        }
      }

      if (!resp.ok) {
        return { content: `HTTP ${resp.status} ${resp.statusText} for ${target.toString()}`, isError: true };
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const reader = resp.body?.getReader();
      if (!reader) return { content: `Empty response body.`, isError: true };

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            chunks.push(value.slice(0, value.byteLength - (total - MAX_RESPONSE_BYTES)));
            break;
          }
          chunks.push(value);
        }
      }
      const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

      let processed = body;
      if (/^text\/html|application\/xhtml/i.test(contentType)) {
        processed = htmlToText(body);
      }

      const summary = args.prompt
        ? `# WebFetch result for: ${args.prompt}`
        : `Fetched ${target.hostname} (${total} bytes${total >= MAX_RESPONSE_BYTES ? ", truncated" : ""})`;
      const truncated = processed.length > 200_000 ? processed.slice(0, 200_000) + "\n\n... [truncated]" : processed;
      const preface = args.prompt ? `# WebFetch result for: ${args.prompt}\n\nSource: ${target.toString()}\n\n` : `Source: ${target.toString()}\n\n`;
      return { content: preface + truncated, summary };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return { content: `WebFetch aborted (timeout or user cancel).`, isError: true };
      }
      return { content: `WebFetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener("abort", onAbort);
    }
  },
});

/**
 * 极简 HTML → 文本：删 script/style，保留段落 / 列表 / 标题 / 链接。
 * 不追求精确——给 LLM 看的近似版本即可。
 */
export function htmlToText(html: string): string {
  let s = html;
  // 删 script / style / svg / noscript
  s = s.replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // 注释
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // 标题
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, txt: string) => {
    return `\n\n${"#".repeat(parseInt(lvl, 10))} ${stripTags(txt).trim()}\n\n`;
  });
  // a 链接
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, txt: string) => {
    const label = stripTags(txt).trim();
    return label ? `[${label}](${href})` : href;
  });
  // 列表项
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt: string) => `\n- ${stripTags(txt).trim()}`);
  // 段落 / 块级
  s = s.replace(/<(p|div|section|article|header|footer|main|aside|nav|pre|blockquote|br|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|pre|blockquote)>/gi, "\n");
  // code 行内
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, txt: string) => `\`${stripTags(txt)}\``);
  // 删剩余标签
  s = stripTags(s);
  // entity 简版
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 合并多空行
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
