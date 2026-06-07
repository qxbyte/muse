/**
 * Compaction 摘要 prompt 模板。
 *
 * 设计文档:模块设计/上下文管理工程/设计.md §4.2(I-2)。
 *
 * 主 schema:9 节结构化(对齐业界共识),要求 LLM 完整列出所有 user 消息原文。
 * 降级 schema:6 节(合并较松散的小节),供未明实测稳定性的 provider 用。
 *
 * 摘要后附加 facts_to_promote JSON(I-5 联动):提取跨 session 价值事实供
 * compactMessages 自动写入长期 memory。LLM 强约束"宁可少不可多",防误存。
 */

export type SummarySchema = "9-section" | "6-section";

const FACTS_BLOCK = `

---

# Extracted Facts for Long-term Memory (optional)

If — and only if — the conversation revealed durable facts worth keeping across future sessions,
output one JSON code block in this format:

\`\`\`json
{
  "facts": [
    {
      "name": "kebab-case-slug",
      "type": "user" | "feedback" | "project" | "reference",
      "description": "one-line summary used as memory index hook",
      "body": "markdown content of the fact"
    }
  ]
}
\`\`\`

Strict constraints (read carefully — over-eager extraction breaks user trust):
- Only include facts with **cross-session value**: user role / preference, project hard rule, validated approach
- Do NOT include: code visible in the repo, git history facts, transient task state, errors already fixed
- Do NOT save chitchat, model-internal reasoning, or speculation
- If nothing meets the bar, output \`{"facts": []}\` — empty is better than noise
- Each fact \`name\` must be a unique slug (kebab- or snake-case alphanumeric)
- For \`feedback\` / \`project\` types, body should lead with the rule, then "Why:" and "How to apply:" lines`;

export function buildSummaryPrompt(transcript: string, schema: SummarySchema): string {
  if (schema === "9-section") {
    return SECTION_9_TEMPLATE.replace("{TRANSCRIPT}", transcript) + FACTS_BLOCK;
  }
  return SECTION_6_TEMPLATE.replace("{TRANSCRIPT}", transcript) + FACTS_BLOCK;
}

const SECTION_9_TEMPLATE = `Summarize the following conversation. Use **exactly these 9 sections in this order**. If a section has no content, write "(none)" — do not skip section numbers.

# Conversation Summary

1. **Primary Request and Intent**
   — Quote the user's original request verbatim (use > markdown quotes). Do not paraphrase.

2. **Key Technical Concepts**
   — Bullet list of frameworks, languages, libraries, patterns relevant to the conversation.

3. **Files and Code Sections**
   — File path + function / class name + what was read or changed. Be concrete.

4. **Errors and fixes**
   — Each error message (or class of error) + the specific fix taken. Future you will repeat these mistakes if this section is sloppy.

5. **Problem Solving**
   — Key reasoning steps and trade-offs considered. "I chose A over B because X."

6. **All user messages**
   — **List every user message verbatim**, separated by \`---\`. Sacred section: NEVER omit, paraphrase, or merge user messages.

7. **Pending Tasks**
   — TODOs the user explicitly stated and items the assistant identified as not-yet-done.

8. **Current Work**
   — What was actively being done at the moment of summarization. One paragraph.

9. **Optional Next Step**
   — Recommended next action, anchored in quote(s) from the user's recent messages. If unclear, write "(awaiting user direction)".

--- BEGIN CONVERSATION ---
{TRANSCRIPT}
--- END CONVERSATION ---`;

const SECTION_6_TEMPLATE = `Summarize the following conversation. Use these 6 sections in order. Do not skip section numbers; write "(none)" for empty sections.

# Conversation Summary

1. **Primary Request and Intent** — Quote the user's original request verbatim.

2. **Concepts, Decisions, and Reasoning** — Frameworks involved + key trade-offs.

3. **Files and Changes** — File paths + what was modified.

4. **Errors and fixes** — Error messages + specific fixes.

5. **All user messages** — List every user message verbatim, separated by \`---\`. Sacred: never omit.

6. **Current Work + Next Step** — What was being done + recommended next action (anchored in user quotes).

--- BEGIN CONVERSATION ---
{TRANSCRIPT}
--- END CONVERSATION ---`;

/**
 * 从 LLM 输出中提取 facts JSON 块。
 *
 * 解析策略:
 *   1. 找 ```json ... ``` 代码块,解析内容
 *   2. 容错:含 facts 字段且为数组才返;否则返 null
 *   3. 单条 fact 字段缺失 / 非 string → 跳过该条
 *   4. 重复 name → 后写覆盖前(无报错)
 */
export interface ExtractedFact {
  name: string;
  type: "user" | "feedback" | "project" | "reference";
  description: string;
  body: string;
}

export function extractFacts(summaryText: string): ExtractedFact[] {
  const jsonBlock = summaryText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!jsonBlock) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock[1].trim());
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];

  const out = new Map<string, ExtractedFact>();
  for (const raw of facts) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : "";
    const type = r.type;
    const description = typeof r.description === "string" ? r.description : "";
    const body = typeof r.body === "string" ? r.body : "";
    if (!name || !description || !body) continue;
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) continue;
    if (type !== "user" && type !== "feedback" && type !== "project" && type !== "reference") continue;
    out.set(name, { name, type, description, body });
  }
  return [...out.values()];
}

/**
 * 把摘要文本里的 facts JSON 代码块剥掉,只留人类可读的摘要主体。
 * compactMessages 用此把"干净摘要"放回 messages,facts JSON 不污染对话。
 */
export function stripFactsBlock(summaryText: string): string {
  return summaryText
    .replace(/---\s*\n\s*#?\s*Extracted Facts[\s\S]*?```(?:json)?[\s\S]*?```/i, "")
    .replace(/```(?:json)?\s*\n[\s\S]*?\n```/g, (match) => {
      // 仅剥 JSON 含 "facts" 的块,其他 code block 保留
      if (/"facts"\s*:/.test(match)) return "";
      return match;
    })
    .trim();
}
