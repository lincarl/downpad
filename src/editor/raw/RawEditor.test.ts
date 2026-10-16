// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { RawEditor } from "./RawEditor";

const editors: RawEditor[] = [];

/** Mount a Markdown pane holding `before` and `after`, with the caret between. */
function mountWithCaret(before: string, after = ""): RawEditor {
  const editor = new RawEditor();
  editor.mount(document.createElement("div"), after, { onChange: () => {} });
  editor.insertText(before);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("RawEditor.setText", () => {
  it.each([
    ["adds text before it", "First line.", "![](a.png)\n\nFirst line.\n", "![](a.png)\n\nFirst line. Typed.\n"],
    ["adds text after it", "First line.", "First line.\n\n![](a.png)\n", "First line. Typed.\n\n![](a.png)\n"],
    ["removes text before it", "Intro.\n\nFirst line.", "First line.\n", "First line. Typed.\n"],
  ])("keeps the caret in place when the other pane %s", (_change, beforeCaret, mirrored, typed) => {
    const editor = mountWithCaret(beforeCaret, "\n");

    editor.setText(mirrored);
    editor.insertText(" Typed.");

    expect(editor.getText()).toBe(typed);
  });

  it("moves a caret inside the change before a whole emoji, not between its halves", () => {
    // U+1F600 and U+1F601 share their first UTF-16 unit.
    const editor = mountWithCaret("\u{1F600}abc", "def");

    editor.setText("\u{1F601}abcdeg");
    editor.insertText("X");

    expect(editor.getText()).toBe("X\u{1F601}abcdeg");
  });

  it("moves a selection that starts inside the change after a whole emoji", () => {
    const editor = mountWithCaret("", "ab\u{1F600}yz");
    // Select "b", the emoji and "y". The find card is one way to select.
    editor.searchText("b\u{1F600}y", { caseSensitive: true, wholeWord: false, regex: false });

    // U+1F600 and U+1F200 share their second UTF-16 unit.
    editor.setText("cd\u{1F200}yz");
    editor.insertText("X");

    expect(editor.getText()).toBe("cd\u{1F200}Xz");
  });

  it.each([
    ["abcabc", "abc"],
    ["abc", "abcabc"],
    ["aaa", "aa"],
    ["- a\n- b\n", "* a\n* b\n"],
    ["", "text"],
    ["text", ""],
  ])("turns %j into %j", (before, after) => {
    const editor = mountWithCaret(before);

    editor.setText(after);

    expect(editor.getText()).toBe(after);
  });
});
