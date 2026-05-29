/**
 * Session 内 Todo 清单。
 *
 * 仅存活于单次 muse 进程内，不入 JSONL 持久化（任务清单是 ephemeral 调度状态，
 * 不是对话内容；下次进程恢复 session 时 LLM 应基于历史重建清单）。
 *
 * 工具 TodoWrite 通过 ToolContext.todos 写入；buildSystemPrompt 读出注入下一轮 LLM 的视野。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  /** 进行中状态的现在分词式描述，UI 可用作 spinner 文案。 */
  activeForm?: string;
}

export class TodoStore {
  private items: Todo[] = [];

  list(): Todo[] {
    return this.items.slice();
  }

  set(items: Todo[]): void {
    this.items = items.slice();
  }

  clear(): void {
    this.items = [];
  }

  /** 把当前清单格式化为 system prompt 段落；无任务时返回空串。 */
  toPromptSection(): string {
    if (this.items.length === 0) return "";
    const lines = this.items.map((t, i) => {
      const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
      return `  ${i + 1}. ${marker} ${t.content}`;
    });
    return `# Current todos\n${lines.join("\n")}\n\nUpdate via TodoWrite as you make progress. Keep exactly one item in_progress at a time.`;
  }
}
