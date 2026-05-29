import { describe, it, expect } from "vitest";
import { findSafeCutoff } from "../src/loop/context.js";
import type { Message } from "../src/types/index.js";

function user(t: string): Message {
  return { role: "user", content: t };
}
function asst(t: string): Message {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}
function asstTool(id: string): Message {
  return { role: "assistant", content: [{ type: "tool_use", id, name: "Read", args: {} }] };
}
function tool(id: string, c = "ok"): Message {
  return { role: "tool", toolUseId: id, content: c };
}

describe("findSafeCutoff", () => {
  it("returns 0 when history not longer than keepRecent", () => {
    expect(findSafeCutoff([user("a"), asst("b")], 4)).toBe(0);
  });

  it("picks the most recent user before keepRecent boundary", () => {
    const msgs = [user("0"), asst("1"), user("2"), asst("3"), user("4"), asst("5")];
    // length 6, keepRecent 2 → ideal = 4. msgs[4] is user → cutoff 4
    expect(findSafeCutoff(msgs, 2)).toBe(4);
  });

  it("skips boundaries that orphan a tool_use", () => {
    const msgs = [
      user("0"),
      asstTool("t1"),
      tool("t1", "result1"),
      user("3"),
      asstTool("t2"), // orphan in older if we cut at msgs[5]
      user("5"),
      asst("6"),
    ];
    // ideal = 7 - 2 = 5, msgs[5] is user; older = msgs[0..5) has t2 orphan; should fall back
    // msgs[3] is user, older = msgs[0..3) has t1 fully resolved → cutoff 3
    expect(findSafeCutoff(msgs, 2)).toBe(3);
  });

  it("returns 0 when no safe cutoff exists", () => {
    const msgs = [asstTool("t1"), user("1"), asst("2"), user("3")];
    // ideal = 4 - 1 = 3 (user). older = [asstTool t1, user 1, asst 2] orphan → skip
    // msgs[1] is user, older = [asstTool t1] orphan → skip
    // i=0 cannot be a cutoff (loop while i>0)
    expect(findSafeCutoff(msgs, 1)).toBe(0);
  });
});
