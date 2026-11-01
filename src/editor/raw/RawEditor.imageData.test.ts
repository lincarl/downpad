// @vitest-environment jsdom
// The Markdown view can show long base64 image data as its size. Find there
// never matches base64 image data, collapsed or not, so Replace all cannot
// corrupt an embedded image.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { RawEditor } from "./RawEditor";
import type { FindOptions } from "../wysiwyg/findEngine";

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

// Base64 data holds short words by chance. "kq" occurs in this payload.
const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAkqYAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
const png = `![pasted](data:image/png;base64,${pngData})`;
// A 1x1 GIF, too short to collapse. "AQAB" occurs in its payload.
const gif = "![pixel](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)";

let editor: RawEditor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the Markdown editor on `text`. */
function open(text: string, collapseBase64 = true): RawEditor {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new RawEditor();
  editor.mount(root, text, { onChange: () => {} }, { collapseBase64 });
  return editor;
}

describe("base64 image data collapsed in the Markdown view", () => {
  const text = `First line.\n\n${png}\n`;
  const chip = () => document.querySelector(".cm-base64-collapsed");
  const shownText = () => document.querySelector(".cm-content")!.textContent;
  const viewOf = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
  const press = (element: Element) => element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

  it("shows long data as its size, and keeps the data in the text", () => {
    const editor = open(text);

    expect(chip()?.textContent).toBe("…[0.1 KB]");
    expect(shownText()).toContain("![pasted](data:image/png;base64,…[0.1 KB])");
    expect(shownText()).not.toContain(pngData);
    expect(editor.getText()).toBe(text);
  });

  it("shows data too short to collapse as it is", () => {
    open(`First line.\n\n${gif}\n`);

    expect(chip()).toBeNull();
    expect(shownText()).toContain(gif);
  });

  it("shows the data once its size is pressed, and keeps it shown through an edit before it", () => {
    open(text);

    press(chip()!);
    expect(chip()).toBeNull();
    expect(shownText()).toContain(pngData);
    viewOf().dispatch({ changes: { from: 0, insert: "Intro. " } });
    expect(chip()).toBeNull();
  });

  it("shows the data while the caret is in it, so typing there is seen", () => {
    open(text);

    viewOf().dispatch({ selection: { anchor: text.indexOf(pngData) + 5 } });

    expect(chip()).toBeNull();
    expect(shownText()).toContain(pngData);
  });
});

describe("find in the Markdown view", () => {
  it.each([
    ["on", true],
    ["off", false],
  ])("skips base64 image data with collapsing %s", (_name, collapseBase64) => {
    const editor = open(`Visible kq.\n\n${png}\n`, collapseBase64);
    expect(editor.searchText("kq", opts)).toEqual({ current: 1, total: 1 });
    expect(editor.findNext()).toEqual({ current: 1, total: 1 });
    editor.replaceAll("ZZ", "kq", opts);
    expect(editor.getText()).toBe(`Visible ZZ.\n\n${png}\n`);
  });

  // Other tools write media type parameters, and RFC 2397 allows any case.
  it.each([
    "data:image/svg+xml;charset=utf-8;base64,",
    "data:image/png;name=shot.png;base64,",
    "data:image/png;BASE64,",
  ])("skips the data after %s", (prefix) => {
    const image = `![pasted](${prefix}${pngData})`;
    const editor = open(`Visible kq.\n\n${image}\n`);
    expect(editor.searchText("kq", opts)).toEqual({ current: 1, total: 1 });
    editor.replaceAll("ZZ", "kq", opts);
    expect(editor.getText()).toBe(`Visible ZZ.\n\n${image}\n`);
  });

  it("skips the data of an image too small to collapse", () => {
    const editor = open(`Tag AQAB.\n\n${gif}\n`);
    expect(editor.searchText("AQAB", opts)).toEqual({ current: 1, total: 1 });
  });

  it("still finds the visible parts of an embedded image", () => {
    const editor = open(`Visible kq.\n\n${png}\n`);
    expect(editor.searchText("pasted", opts)).toEqual({ current: 1, total: 1 });
    expect(editor.searchText("image/png", opts)).toEqual({ current: 1, total: 1 });
  });
});

describe("a file dropped on base64 image data in the Markdown view", () => {
  const LINK = "[a.csv](attachments/a.csv)";
  const titled = `![pasted](data:image/png;base64,${pngData} "Title")`;

  /** Drop LINK where the pane finds the text position `offset` into the image's data. */
  function dropInData(image: string, offset: (dataStart: number, dataEnd: number) => number): string {
    const text = `First line.\n\n${image} After.\n`;
    const opened = open(text);
    const dataStart = text.indexOf(pngData);
    const { view } = opened as unknown as { view: EditorView };
    // The collapsed chip covers the data, so the pane finds one of its ends.
    vi.spyOn(view, "posAtCoords").mockReturnValue(offset(dataStart, dataStart + pngData.length));
    opened.insertText(LINK, opened.dropTargetAt(10, 10));
    opened.insertText("!");
    return opened.getText();
  }

  it.each([
    ["at the start of the data", (start: number) => start],
    ["inside the data", (start: number) => start + 20],
    ["at the end of the data", (_start: number, end: number) => end],
  ])("goes in after the image, %s, and so does the next key", (_where, offset) => {
    expect(dropInData(png, offset)).toBe(`First line.\n\n${png}${LINK}! After.\n`);
  });

  it("goes in after an image with a title", () => {
    expect(dropInData(titled, (start) => start)).toBe(`First line.\n\n${titled}${LINK}! After.\n`);
  });

  it("goes in after the link around an image", () => {
    const linked = `[${png}](https://example.com)`;
    expect(dropInData(linked, (start) => start)).toBe(`First line.\n\n${linked}${LINK}! After.\n`);
  });

  const uri = `data:image/png;base64,${pngData}`;
  const html = `<img src="${uri}" alt="pic">`;
  // Here the data has no end inside its line that a file could follow, so the
  // files go in as paragraphs of their own after the block holding the data,
  // which stays in one piece.
  it.each([
    ["a reference definition", `[logo]: ${uri}`, "[other]: other.png\n"],
    ["an HTML image in a line of text", `${html} (figure 1)`, "\nLast line.\n"],
    ["code", `Use \`url(${uri})\` here.`, "\nLast line.\n"],
    ["an HTML block", `<p align="center">\n${html}\n</p>`, "\nLast line.\n"],
    ["a table", `| a | b |\n| - | - |\n| ${html} | x |\n| c | d |`, "\nLast line.\n"],
    ["a list", `- ${html}\n- next`, "\nLast line.\n"],
    ["a code block", `\`\`\`css\n.a { background: url(${uri}); }\n\`\`\``, "After code.\n"],
  ])("goes in after the block that holds it, not into the data, in %s", (_where, block, rest) => {
    const text = `First line.\n\n${block}\n${rest}`;
    const opened = open(text);
    const { view } = opened as unknown as { view: EditorView };
    vi.spyOn(view, "posAtCoords").mockReturnValue(text.indexOf(pngData) + pngData.length);
    const target = opened.dropTargetAt(10, 10);
    opened.insertText(LINK, target);
    opened.insertText("!");
    opened.insertText("[b.csv](attachments/b.csv)", target, false);

    expect(opened.getText()).toBe(`First line.\n\n${block}\n\n${LINK}!\n\n[b.csv](attachments/b.csv)\n\n${rest.replace(/^\n/, "")}`);
  });

  // These take in all the text after them, so the files go in before them.
  it.each([
    ["a code fence not closed yet", "First line.\n\n", `\`\`\`html\n${html}\n`],
    ["an HTML comment not closed yet", "First line.\n", `<!-- old figure\n${html}\n`],
    ["a code fence not closed yet that starts the text", "", `\`\`\`html\n${html}`],
  ])("goes in before the block that holds it, not into it, in %s", (_where, start, block) => {
    const text = `${start}${block}`;
    const opened = open(text);
    const { view } = opened as unknown as { view: EditorView };
    vi.spyOn(view, "posAtCoords").mockReturnValue(text.indexOf(pngData));
    const target = opened.dropTargetAt(10, 10);
    opened.insertText(LINK, target);
    opened.insertText("!");
    opened.insertText("[b.csv](attachments/b.csv)", target, false);

    const lead = start ? "First line.\n\n" : "";
    expect(opened.getText()).toBe(`${lead}${LINK}!\n\n[b.csv](attachments/b.csv)\n\n${block}`);
  });
});
