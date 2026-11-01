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

  it("1. an image file comes before text and HTML here", () => {
    // docs/spec.md puts a paste's text or HTML in instead of its image. The
    // editor does that before this step. pasteHandler takes only an image
    // pasted alone, and Milkdown's clipboard plugin takes one with text or HTML.
    const file = { type: "image/png" } as File;
    const action = resolvePaste(
      snap({ imageFile: file, html: "<b>x</b>", text: "# heading" }),
      fakeConvert,
    );
    expect(action).toEqual({ kind: "image", file });
  });

  it("2. markdown-looking plain text is parsed as markdown", () => {
    const action = resolvePaste(snap({ text: "# Title\n\n- a\n- b" }), fakeConvert);
    expect(action).toEqual({ kind: "markdown", md: "# Title\n\n- a\n- b" });
  });

  it("3. real HTML converts to markdown, ahead of ordinary plain text", () => {
    const action = resolvePaste(
      snap({ html: "<table><tr><td>a</td></tr></table>", text: "a" }),
      fakeConvert,
    );
    expect(action).toEqual({ kind: "markdown", md: "MD(<table><tr><td>a</td></tr></table>)" });
  });

  it("3b. ignores HTML with no real tags and falls through to text", () => {
    const action = resolvePaste(snap({ html: "just text, no tags", text: "just text" }), fakeConvert);
    expect(action).toEqual({ kind: "text", text: "just text" });
  });

  it("3c. ignores HTML that converts to empty", () => {
    const action = resolvePaste(snap({ html: "<span></span>", text: "plain" }), () => "");
    expect(action).toEqual({ kind: "text", text: "plain" });
  });

  it("4. ordinary plain text stays literal", () => {
    const action = resolvePaste(snap({ text: "just a sentence" }), fakeConvert);
    expect(action).toEqual({ kind: "text", text: "just a sentence" });
  });

  it("empty clipboard → empty", () => {
    expect(resolvePaste(snap({}), fakeConvert)).toEqual({ kind: "empty" });
  });
});
