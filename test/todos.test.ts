import { describe, it, expect } from "vitest";
import { TodoStore } from "../src/loop/todos.js";

describe("TodoStore", () => {
  it("starts empty and stays clean", () => {
    const s = new TodoStore();
    expect(s.list()).toEqual([]);
    expect(s.toPromptSection()).toBe("");
  });

  it("set replaces and list returns a copy", () => {
    const s = new TodoStore();
    s.set([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
    const copy = s.list();
    copy.push({ content: "x", status: "pending" });
    expect(s.list().length).toBe(2);
  });

  it("prompt section uses markers and references TodoWrite", () => {
    const s = new TodoStore();
    s.set([{ content: "do thing", status: "pending" }]);
    const section = s.toPromptSection();
    expect(section).toContain("[ ] do thing");
    expect(section).toContain("TodoWrite");
  });
});
