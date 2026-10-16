// @vitest-environment jsdom
// Replace in the Markdown view. Replace moves on to the next match instead of
// going back to the first one, and with the caret off a match it selects the
// next match first.

import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { RawEditor } from "./RawEditor";
import type { FindOptions } from "../wysiwyg/findEngine";

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: RawEditor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the Markdown editor on `text`. */
function open(text: string): RawEditor {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new RawEditor();
  editor.mount(root, text, { onChange: () => {} });
  return editor;
}

/** The line that holds the current match. */
const currentLine = () => document.querySelector(".md-find-current")?.closest(".cm-line")?.textContent;

describe("replace in the Markdown view", () => {
  it("moves on to the next match after Replace", () => {
    const editor = open("# Heading alpha\n\nalpha one\n\nalpha two\n\nalpha three\n");
    expect(editor.searchText("alpha", opts)).toEqual({ current: 1, total: 4 });
    editor.findNext();
    expect(editor.findNext()).toEqual({ current: 3, total: 4 });

    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 3, total: 3 });
    expect(currentLine()).toBe("alpha three");
    expect(editor.getText()).toBe("# Heading alpha\n\nalpha one\n\nBETA two\n\nalpha three\n");

    // After the last match it wraps to the first.
    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 1, total: 2 });
    expect(currentLine()).toBe("# Heading alpha");
  });

  it("selects the next match after the caret before it replaces anything", () => {
    const text = "# Heading alpha\n\nalpha one\n\nalpha two\n\nplain line\n\nalpha four\n";
    const editor = open(text);
    editor.searchText("alpha", opts);
    editor.findNext();
    expect(editor.findNext()).toEqual({ current: 3, total: 4 });

    // A click on "plain line" puts the caret on no match.
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ selection: { anchor: text.indexOf("plain line") } });
    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 4, total: 4 });
    expect(editor.getText()).toBe(text);
    expect(currentLine()).toBe("alpha four");

    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 1, total: 3 });
    expect(editor.getText()).toBe(text.replace("alpha four", "BETA four"));
  });

  it("does nothing without a query", () => {
    const editor = open("alpha one\n");
    expect(editor.replaceCurrent("BETA", "", opts)).toEqual({ current: 0, total: 0 });
    expect(editor.getText()).toBe("alpha one\n");
    // CodeMirror's own search panel stays closed. The find card replaces it.
    expect(document.querySelector(".cm-search")).toBeNull();
  });

  it("skips a replacement that contains the query", () => {
    const editor = open("cat one\ncat two\n");
    editor.searchText("cat", opts);
    expect(editor.replaceCurrent("cats", "cat", opts)).toEqual({ current: 2, total: 2 });
    expect(currentLine()).toBe("cat two");
  });
});
