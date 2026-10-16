// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("RawEditor.applyDropEdit", () => {
  const LINK = "[a.csv](attachments/a.csv)";

  it("keeps the caret where the user types, on either side of the file", () => {
    // Typing at the end of the line the file goes in after.
    const end = mountWithCaret("First line.", "\n\nSecond line.\n");
    end.applyDropEdit({ from: 11, to: 11, insert: `\n\n${LINK}`, assoc: -1 });
    end.insertText(" Typed.");
    expect(end.getText()).toBe(`First line. Typed.\n\n${LINK}\n\nSecond line.\n`);

    // Typing at the start of the first line, which the file goes in before.
    const start = mountWithCaret("", "First line.\n");
    start.applyDropEdit({ from: 0, to: 0, insert: `${LINK}\n\n`, assoc: 1 });
    start.insertText("Typed. ");
    expect(start.getText()).toBe(`${LINK}\n\nTyped. First line.\n`);
  });

  it("replaces only the part of a rewritten block that changed, so a caret in it keeps its place", () => {
    const editor = mountWithCaret("- a", "\n- b\n");

    editor.applyDropEdit({ from: 0, to: 7, insert: `- a\n- ${LINK}\n- b`, assoc: -1 });
    editor.insertText("x");

    expect(editor.getText()).toBe(`- ax\n- ${LINK}\n- b\n`);
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

  // The document pane's report can change several places at once. Its first
  // edit writes these bullets in its own form, and Replace all changes every match.
  it.each([
    [
      "an edit that rewrites the source",
      "* Alpha\n* Beta\n\nFirst line.\n\nSecond line.\n\nThird line.\n\n* Gamma\n* Delta\n",
      "- Alpha\n- Beta\n\nFirst line.\n\nSecond line.\n\nThird line.X\n\n- Gamma\n- Delta\n",
    ],
    ["Replace all", "Alpha word.\n\nFirst line.\n\nSecond line.\n\nOmega word.\n", "Alpha term.\n\nFirst line.\n\nSecond line.\n\nOmega term.\n"],
  ])("keeps a drop's place and the caret between the places %s changed", (_change, text, mirrored) => {
    const editor = mountWithCaret("", text);
    const { view } = editor as unknown as { view: EditorView };
    const lineEnd = text.indexOf("First line.") + "First line.".length;
    vi.spyOn(view, "posAtCoords").mockReturnValue(lineEnd);
    const target = editor.dropTargetAt(10, 10);
    view.dispatch({ selection: { anchor: text.indexOf("Second line.") + "Second".length } });

    editor.setText(mirrored);
    editor.insertText("[n.csv](attachments/n.csv)", target, false);
    typeOver(editor, "!");

    expect(editor.getText()).toBe(mirrored.replace("First line.", "First line.[n.csv](attachments/n.csv)").replace("Second line.", "Second! line."));
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
