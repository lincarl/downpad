// @vitest-environment jsdom
// Find in the Markdown view never matches base64 image data, collapsed or not,
// so Replace all cannot corrupt an embedded image.

import { afterEach, describe, expect, it } from "vitest";
import { RawEditor } from "./RawEditor";
import type { FindOptions } from "../wysiwyg/findEngine";

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

// Base64 data holds short words by chance. "kq" occurs in this payload.
const png = "![pasted](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAkqYAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=)";
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
