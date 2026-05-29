import { describe, it, expect } from "vitest";
import { htmlToText } from "../src/tools/builtin/webfetch.js";

describe("htmlToText", () => {
  it("strips script/style", () => {
    const html = "<html><body><script>evil()</script><style>x</style><p>hi</p></body></html>";
    const txt = htmlToText(html);
    expect(txt).not.toContain("evil");
    expect(txt).not.toContain("style");
    expect(txt).toContain("hi");
  });

  it("preserves headings", () => {
    const txt = htmlToText("<h1>Title</h1><h3>Sub</h3>");
    expect(txt).toContain("# Title");
    expect(txt).toContain("### Sub");
  });

  it("preserves anchor with href", () => {
    const txt = htmlToText('<a href="https://x.com/y">click</a>');
    expect(txt).toContain("[click](https://x.com/y)");
  });

  it("converts list items", () => {
    const txt = htmlToText("<ul><li>one</li><li>two</li></ul>");
    expect(txt).toContain("- one");
    expect(txt).toContain("- two");
  });

  it("decodes basic entities", () => {
    expect(htmlToText("<p>A &amp; B &lt;c&gt;</p>")).toContain("A & B <c>");
  });
});
