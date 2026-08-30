// @vitest-environment jsdom
// Turndown needs a DOM; this file overrides the default node env (jsdom devDep).
import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown";

describe("htmlToMarkdown", () => {
  it("converts basic formatting with our serializer style", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toBe("# Title");
    expect(htmlToMarkdown("<p>This is <strong>bold</strong> and <em>italic</em>.</p>")).toBe(
      "This is **bold** and *italic*.",
    );
    expect(htmlToMarkdown('<a href="https://anthropic.com">Anthropic</a>')).toBe(
      "[Anthropic](https://anthropic.com)",
    );
  });

  it("converts unordered lists with - markers", () => {
    expect(htmlToMarkdown("<ul><li>one</li><li>two</li></ul>")).toBe("-   one\n-   two");
  });

  it("converts tables to GFM (the Excel/Sheets/Notion paste path)", () => {
    const html =
      "<table><thead><tr><th>Feature</th><th>Status</th></tr></thead>" +
      "<tbody><tr><td>WYSIWYG</td><td>M1</td></tr></tbody></table>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("| Feature | Status |");
    expect(md).toContain("| --- | --- |");
    // Turndown pads cells to the column width, so allow trailing spaces.
    expect(md).toMatch(/\| WYSIWYG \| M1 +\|/);
  });

  it("converts strikethrough (GFM)", () => {
    expect(htmlToMarkdown("<p><del>gone</del></p>")).toBe("~~gone~~");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
  });
});
