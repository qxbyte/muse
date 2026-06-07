/**
 * AskUserQuestion 工具：在 agent loop 内同步弹出选择题让用户作答。
 *
 * 流程：tool.execute → ctx.askQuestion(req) → App 渲染 QuestionPicker → 用户 ↑↓ 选 + Enter
 * → resolve 把结果传回 → tool 把答案拼成文本喂给 LLM。Esc 取消会返回 cancelled=true。
 *
 * 一次调用可塞多个 questions（对齐业界 Q&A picker 形态），逐题展示，任一题 Esc 视为整批取消。
 *
 * 注意：tool 本身不调任何外部资源，permission 用 read（不弹权限确认）。
 */

import { z } from "zod";
import { defineTool } from "../types.js";

export const AskQuestionOptionSchema = z.object({
  label: z.string().min(1).describe("Option text shown to the user. Concise (1-5 words)."),
  description: z
    .string()
    .optional()
    .describe("Optional one-line explanation of what this option means."),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional rich preview rendered in a right-side panel when this option is focused. " +
        "Use for code/diagram/config snippets that help compare options visually. " +
        "Multi-line text supported.",
    ),
});

export const AskQuestionSchema = z.object({
  question: z.string().min(1).describe("Full question text (end with ?)."),
  header: z
    .string()
    .min(1)
    .max(16)
    .describe("Very short label (chip), max 12 chars. E.g. 'Auth method'."),
  options: z
    .array(AskQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 options. Mutually exclusive unless multiSelect=true."),
  multiSelect: z
    .boolean()
    .optional()
    .describe("Allow multiple selections. Default false."),
});

export type AskQuestion = z.infer<typeof AskQuestionSchema>;
export type AskQuestionOption = z.infer<typeof AskQuestionOptionSchema>;

export interface AskQuestionResponse {
  cancelled: boolean;
  /** 单选：单元素数组；多选：所选 label 列表。cancelled=true 时为空。 */
  selections: string[];
  /** 用户对该题用 'n' 添加的自由备注。空字符串表示未填。 */
  notes?: string;
}

const AskUserQuestionArgs = z.object({
  questions: z
    .array(AskQuestionSchema)
    .min(1)
    .max(4)
    .describe("1-4 questions to ask the user sequentially."),
});

export const AskUserQuestionTool = defineTool({
  name: "AskUserQuestion",
  description:
    "Ask the user one or more multiple-choice questions when their input is needed to proceed. " +
    "Each question has 2-4 options. Use multiSelect=true for non-mutually-exclusive choices. " +
    "Prefer this over plain-text questions when the answer space is bounded. " +
    "If the user presses Esc, the entire batch is treated as cancelled.",
  parameters: AskUserQuestionArgs,
  permission: "read",
  summarize: (args) =>
    `AskUserQuestion(${args.questions.length} question${args.questions.length === 1 ? "" : "s"})`,
  async execute(args, ctx) {
    if (!ctx.askQuestions) {
      return {
        content:
          "AskUserQuestion is unavailable: this agent run has no question handler. " +
          "(Internal bug; tell the user.)",
        isError: true,
      };
    }

    const responses = await ctx.askQuestions(args.questions);
    // Esc 取消时所有项 cancelled=true（UI 一次性返回整批）
    if (responses.length > 0 && responses[0].cancelled) {
      return {
        content: "User cancelled (Esc). No answers were collected.",
        isError: false,
      };
    }

    const blocks = args.questions.map((q, qi) => {
      const r = responses[qi];
      const sel = r?.selections ?? [];
      const ans = sel.length === 0 ? "(no answer)" : sel.join(", ");
      const notes = r?.notes?.trim();
      return notes ? `Q: ${q.question}\nA: ${ans}\nNotes: ${notes}` : `Q: ${q.question}\nA: ${ans}`;
    });

    return {
      content: blocks.join("\n\n"),
      summary: `Asked ${args.questions.length} question${args.questions.length === 1 ? "" : "s"}`,
    };
  },
});
