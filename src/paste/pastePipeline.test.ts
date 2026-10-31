import { describe, it, expect } from "vitest";
import { resolvePaste, type ClipboardSnapshot } from "./pastePipeline";

const snap = (over: Partial<ClipboardSnapshot>): ClipboardSnapshot => ({
  html: "",
  text: "",
  imageFile: null,
  ...over,
});

// A stub converter so these tests stay DOM-free (the real one needs jsdom).
const fakeConvert = (html: string) => `MD(${html})`;

describe("resolvePaste priority order (spec §5.4)", () => {
  it("keeps Markdown source instead of its syntax-highlighted HTML", () => {
    const md = "---\ntitle: sample\n---\n\n# Heading\n";
    expect(resolvePaste(snap({ text: md, html: `<pre><code>${md}</code></pre>` }), fakeConvert))
      .toEqual({ kind: "markdown", md });
  });

  it("1. image beats everything", () => {
    const file = { type: "image/png" } as File;
    const action = resolvePaste(
      snap({ imageFile: file, html: "<b>x</b>", text: "# heading" }),
      fakeConvert,
    );
    expect(action).toEqual({ kind: "image", file });
  });

  it("2. real HTML converts to markdown", () => {
    const action = resolvePaste(snap({ html: "<table><tr><td>a</td></tr></table>" }), fakeConvert);
    expect(action).toEqual({ kind: "markdown", md: "MD(<table><tr><td>a</td></tr></table>)" });
  });

  it("2b. ignores HTML with no real tags and falls through to text", () => {
    const action = resolvePaste(snap({ html: "just text, no tags", text: "just text" }), fakeConvert);
    expect(action).toEqual({ kind: "text", text: "just text" });
  });

  it("2c. ignores HTML that converts to empty", () => {
    const action = resolvePaste(snap({ html: "<span></span>", text: "plain" }), () => "");
    expect(action).toEqual({ kind: "text", text: "plain" });
  });

  it("3. markdown-looking plain text is parsed as markdown", () => {
    const action = resolvePaste(snap({ text: "# Title\n\n- a\n- b" }), fakeConvert);
    expect(action).toEqual({ kind: "markdown", md: "# Title\n\n- a\n- b" });
  });

  it("4. ordinary plain text stays literal", () => {
    const action = resolvePaste(snap({ text: "just a sentence" }), fakeConvert);
    expect(action).toEqual({ kind: "text", text: "just a sentence" });
  });

  it("empty clipboard → empty", () => {
    expect(resolvePaste(snap({}), fakeConvert)).toEqual({ kind: "empty" });
  });
});
