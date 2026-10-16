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
