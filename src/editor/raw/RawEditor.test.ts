// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
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

/** Type `text` over the selection, as a key press does. */
function typeOver(editor: RawEditor, text: string): void {
  const { view } = editor as unknown as { view: EditorView };
  view.dispatch(view.state.replaceSelection(text));
}

const FIND = { caseSensitive: true, wholeWord: false, regex: false };

describe("RawEditor.insertText", () => {
  it("puts a dropped file after the selected text, such as the find card's match, not over it", () => {
    const editor = mountWithCaret("", "First line.\n");
    editor.searchText("line", FIND);

    editor.insertText("[a.csv](attachments/a.csv)");
    typeOver(editor, "!");

    expect(editor.getText()).toBe("First line[a.csv](attachments/a.csv)!.\n");
  });

  it("leaves the selection as it was, without the file, for a user who has moved on", () => {
    const editor = mountWithCaret("", "First line.\n");
    editor.searchText("line", FIND);

    editor.insertText("[a.csv](attachments/a.csv)", null, false);
    typeOver(editor, "!");

    expect(editor.getText()).toBe("First ![a.csv](attachments/a.csv).\n");
  });
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
    editor.searchText("b\u{1F600}y", FIND);

    // U+1F600 and U+1F200 share their second UTF-16 unit.
    editor.setText("cd\u{1F200}yz");
    typeOver(editor, "X");

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
