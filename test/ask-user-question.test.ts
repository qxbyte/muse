import { describe, it, expect, vi } from "vitest";
import { AskUserQuestionTool } from "../src/tools/builtin/ask-user-question.js";
import type { ToolContext } from "../src/tools/types.js";
import type { AskQuestion, AskQuestionResponse } from "../src/tools/builtin/ask-user-question.js";

const baseCtx = (
  askQuestions?: (qs: AskQuestion[]) => Promise<AskQuestionResponse[]>,
): ToolContext => ({
  cwd: "/",
  askPermission: async () => true,
  askQuestions,
});

describe("AskUserQuestionTool", () => {
  it("errors when askQuestions is not wired", async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          {
            question: "Which one?",
            header: "Choice",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      baseCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no question handler/);
  });

  it("returns formatted Q/A text on single-select answer", async () => {
    const handler = vi.fn<[AskQuestion[]], Promise<AskQuestionResponse[]>>(async () => [
      { cancelled: false, selections: ["Option B"] },
    ]);
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          {
            question: "Pick one?",
            header: "Q1",
            options: [{ label: "Option A" }, { label: "Option B" }],
          },
        ],
      },
      baseCtx(handler),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Q: Pick one?");
    expect(result.content).toContain("A: Option B");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("joins multi-select selections with comma", async () => {
    const handler = async (): Promise<AskQuestionResponse[]> => [
      { cancelled: false, selections: ["A", "C"] },
    ];
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          {
            question: "Multi?",
            header: "Multi",
            multiSelect: true,
            options: [{ label: "A" }, { label: "B" }, { label: "C" }],
          },
        ],
      },
      baseCtx(handler),
    );
    expect(result.content).toContain("A: A, C");
  });

  it("Esc cancels the whole batch", async () => {
    const handler = vi
      .fn<[AskQuestion[]], Promise<AskQuestionResponse[]>>()
      .mockResolvedValue([
        { cancelled: true, selections: [] },
        { cancelled: true, selections: [] },
        { cancelled: true, selections: [] },
      ]);

    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: "Q1?", header: "Q1", options: [{ label: "A" }, { label: "B" }] },
          { question: "Q2?", header: "Q2", options: [{ label: "X" }, { label: "Y" }] },
          { question: "Q3?", header: "Q3", options: [{ label: "1" }, { label: "2" }] },
        ],
      },
      baseCtx(handler),
    );
    expect(handler).toHaveBeenCalledTimes(1); // 一次 batch 调用
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/cancelled/i);
  });

  it("handles per-question answers in a batch", async () => {
    const handler = async (): Promise<AskQuestionResponse[]> => [
      { cancelled: false, selections: ["Yes"] },
      { cancelled: false, selections: ["Red", "Blue"] },
      { cancelled: false, selections: [] }, // 用户跳过
    ];
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: "Continue?", header: "Y/N", options: [{ label: "Yes" }, { label: "No" }] },
          {
            question: "Colors?",
            header: "Colors",
            multiSelect: true,
            options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
          },
          { question: "Skip?", header: "Skip", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
      baseCtx(handler),
    );
    expect(result.content).toContain("A: Yes");
    expect(result.content).toContain("A: Red, Blue");
    expect(result.content).toContain("A: (no answer)");
  });
});
