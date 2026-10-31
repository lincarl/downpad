import { describe, it, expect } from "vitest";
import { looksLikeMarkdown } from "./markdownHeuristic";

describe("looksLikeMarkdown", () => {
  it("recognizes complete leading frontmatter without other Markdown", () => {
    expect(looksLikeMarkdown("---\ntitle: sample\n---")).toBe(true);
    expect(looksLikeMarkdown("---\r\ntitle: sample\r\n...\r\n")).toBe(true);
    expect(looksLikeMarkdown("\uFEFF---\rtitle: sample\r---\r")).toBe(true);
    expect(looksLikeMarkdown("---\ntitle: unfinished")).toBe(false);
  });

  it("detects ATX headings", () => {
    expect(looksLikeMarkdown("# Title\n\nbody")).toBe(true);
    expect(looksLikeMarkdown("### Sub heading here")).toBe(true);
  });

  it("detects fenced code blocks", () => {
    expect(looksLikeMarkdown("```ts\nconst x = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("~~~\ncode\n~~~")).toBe(true);
  });

  it("detects GFM table separators", () => {
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("| left | right |\n|:---|---:|")).toBe(true);
  });

  it("detects links and bold", () => {
    expect(looksLikeMarkdown("see [Anthropic](https://anthropic.com)")).toBe(true);
    expect(looksLikeMarkdown("this is **important** text")).toBe(true);
    expect(looksLikeMarkdown("this is __important__ text")).toBe(true);
  });

  it("detects list markers and block quotes", () => {
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
    expect(looksLikeMarkdown("> a quote")).toBe(true);
  });

  it("treats ordinary prose as not markdown", () => {
    expect(looksLikeMarkdown("Just a normal sentence with no markup.")).toBe(false);
    expect(looksLikeMarkdown("A dash - in the middle of a line is fine.")).toBe(false);
    expect(looksLikeMarkdown("Prices are 5 * 3 = 15 in total.")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });

  it("does not flag empty emphasis markers", () => {
    expect(looksLikeMarkdown("a ** b ** c")).toBe(false);
  });
});
