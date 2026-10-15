import { describe, it, expect } from "vitest";
import { escapeLinkText, encodeLinkUrl, mdLink, mdImage } from "./mdLink";

describe("escapeLinkText", () => {
  it("escapes brackets and backslashes", () => {
    expect(escapeLinkText("a[b]c")).toBe("a\\[b\\]c");
    expect(escapeLinkText("plain.pdf")).toBe("plain.pdf");
  });
});

describe("encodeLinkUrl", () => {
  it("leaves simple paths and data URIs bare", () => {
    expect(encodeLinkUrl("attachments/img.png")).toBe("attachments/img.png");
    expect(encodeLinkUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("wraps paths with spaces or parentheses in angle brackets", () => {
    expect(encodeLinkUrl("attachments/Q3 report (final).pdf")).toBe(
      "<attachments/Q3 report (final).pdf>",
    );
  });
});

describe("mdLink / mdImage", () => {
  it("produces a parseable link for a filename with spaces and parens", () => {
    expect(mdLink("Q3 report (final).pdf", "attachments/Q3 report (final).pdf")).toBe(
      "[Q3 report (final).pdf](<attachments/Q3 report (final).pdf>)",
    );
  });

  it("produces a bare image for a simple relative path", () => {
    expect(mdImage("", "attachments/a.png")).toBe("![](attachments/a.png)");
  });

  it("adds a quoted title and escapes the alt text and title", () => {
    expect(mdImage("a ] b", "my image.png", 'Say "hi"')).toBe(
      '![a \\] b](<my image.png> "Say \\"hi\\"")',
    );
  });
});
