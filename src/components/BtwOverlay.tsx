/**
 * /btw 旁白浮层。
 *
 * 用当前对话作上下文跑一次无工具 LLM 流，答案 stream 到浮层；Q & A 都不进 messages。
 * 关闭键：Enter / Esc / Space（与 Claude Code /btw 对齐）。
 *
 * v0.1 留 TODO：
 *   - 浮层内 ↑↓ 滚动（当前依赖终端 reflow）
 *   - `f` 分支为新会话
 *   - `x` 清除早先 /btw 交换列表（当前同时只能有一个 /btw）
 *   - 并发于主 turn 运行（当前 slash 调度对 status !== idle 一律拒绝）
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { LLMClient } from "../llm/types.js";
import type { Message } from "../types/index.js";

export interface BtwRequest {
  question: string;
  history: Message[];
  resolve: () => void;
}

const BTW_SYSTEM_PROMPT =
  `You are answering a side question from the user. Your reply is shown in a transient ` +
  `popup overlay and will NOT be saved to the conversation history. You have NO tools — ` +
  `answer directly from the conversation context above and your own knowledge. Be concise.`;

export function BtwOverlay({ request, llm }: { request: BtwRequest; llm: LLMClient }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"streaming" | "done" | "error">("streaming");
  const [errMsg, setErrMsg] = useState("");
  const abortRef = useRef(new AbortController());

  useEffect(() => {
    const controller = abortRef.current;
    let cancelled = false;
    (async () => {
      try {
        const stream = llm.stream({
          messages: [...request.history, { role: "user", content: request.question }],
          systemPrompt: BTW_SYSTEM_PROMPT,
          abortSignal: controller.signal,
        });
        for await (const ev of stream) {
          if (cancelled) break;
          if (ev.type === "text") {
            setText((t) => t + ev.delta);
          } else if (ev.type === "error") {
            throw ev.error;
          }
        }
        if (!cancelled) setStatus("done");
      } catch (err) {
        if (cancelled) return;
        setErrMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // request 每次拉起都是新对象——deps 用 request 本身即可，question/history 跟着变
  }, [llm, request]);

  useInput((input, key) => {
    if (key.return || key.escape || input === " ") {
      abortRef.current.abort();
      request.resolve();
    }
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>/btw </Text>
        <Text dimColor>side question · not saved to history</Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Text color="gray">{"› "}</Text>
        <Text bold>{request.question}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {text ? <Text>{text}</Text> : null}
        {status === "streaming" && !text && <Text dimColor>answering…</Text>}
        {status === "error" && <Text color="red">[error] {errMsg}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter / Esc / Space  close</Text>
      </Box>
    </Box>
  );
}
