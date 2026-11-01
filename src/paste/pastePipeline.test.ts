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

  it("puts in text or HTML copied with an image instead of the image", () => {
    const file = { type: "image/png" } as File;
    expect(resolvePaste(snap({ imageFile: file, html: "<b>x</b>", text: "# heading" }), fakeConvert))
      .toEqual({ kind: "markdown", md: "# heading" });
    expect(resolvePaste(snap({ imageFile: file, html: "<img src=x>" }), fakeConvert))
      .toEqual({ kind: "markdown", md: "MD(<img src=x>)" });
    expect(resolvePaste(snap({ imageFile: file, text: "caption" }), fakeConvert))
      .toEqual({ kind: "text", text: "caption" });
  });

  it("1. markdown-looking plain text is parsed as markdown", () => {
    const action = resolvePaste(snap({ text: "# Title\n\n- a\n- b" }), fakeConvert);
    expect(action).toEqual({ kind: "markdown", md: "# Title\n\n- a\n- b" });
  });

  it("2. real HTML converts to markdown, ahead of ordinary plain text", () => {
    const action = resolvePaste(
      snap({ html: "<table><tr><td>a</td></tr></table>", text: "a" }),
      fakeConvert,
    );
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

  it("3. ordinary plain text stays literal", () => {
    const action = resolvePaste(snap({ text: "just a sentence" }), fakeConvert);
    expect(action).toEqual({ kind: "text", text: "just a sentence" });
  });

  it("4. an image alone on the clipboard goes in", () => {
    const file = { type: "image/png" } as File;
    expect(resolvePaste(snap({ imageFile: file }), fakeConvert)).toEqual({ kind: "image", file });
  });

  it("empty clipboard → empty", () => {
    expect(resolvePaste(snap({}), fakeConvert)).toEqual({ kind: "empty" });
  });
});
