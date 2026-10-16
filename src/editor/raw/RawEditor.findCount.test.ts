// @vitest-environment jsdom
// The find card's count follows edits made while it is open (§5.13). These
// tests use the real Markdown editor to check which changes it reports.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { findNext } from "@codemirror/search";
import { RawEditor } from "./RawEditor";
import type { FindOptions } from "../wysiwyg/findEngine";

// CodeMirror measures text a frame after an edit, and jsdom has no layout. Text
// ranges get the empty boxes a browser gives hidden text.
Object.assign(Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new DOMRect(),
});

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: RawEditor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the Markdown editor on `text`, recording its find change reports. */
function open(text: string): { editor: RawEditor; view: EditorView; onFindChange: ReturnType<typeof vi.fn> } {
  const root = document.createElement("div");
  document.body.append(root);
  const onFindChange = vi.fn();
  editor = new RawEditor();
  editor.mount(root, text, { onChange: () => {}, onFindChange });
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!;
  return { editor, view, onFindChange };
}

/** Wait past the pause the Markdown view waits for before it recounts. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Type `text` at the end of the first line. */
function typeOnFirstLine(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: text } });
}

describe("find count changes in the Markdown view", () => {
  it("reports edits once they pause, with the new count", async () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n\nOmega zeta.\n");
    expect(editor.searchText("zeta", opts)).toEqual({ current: 1, total: 2 });

    // Counting walks the whole document, so a burst of typing is counted once.
    typeOnFirstLine(view, " zeta");
    typeOnFirstLine(view, " zeta");
    expect(onFindChange).not.toHaveBeenCalled();
    await settle();
    expect(onFindChange).toHaveBeenCalledOnce();
    // The selected match moves along with the edits and stays current.
    expect(editor.currentCounts()).toEqual({ current: 1, total: 4 });

    // A closed editor has nothing left to report.
    typeOnFirstLine(view, " zeta");
    editor.destroy();
    await settle();
    expect(onFindChange).toHaveBeenCalledOnce();
  });

  it("reports a caret move, which can leave no match current", async () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n\nOmega zeta.\n");
    expect(editor.searchText("zeta", opts)).toEqual({ current: 1, total: 2 });
    await settle();
    onFindChange.mockClear();

    // A click on the empty line between the matches.
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    await settle();
    expect(onFindChange).toHaveBeenCalledOnce();
    expect(editor.currentCounts()).toEqual({ current: 0, total: 2 });

    // CodeMirror's own find next (Ctrl+G) selects a match without the find card.
    findNext(view);
    await settle();
    expect(onFindChange).toHaveBeenCalledTimes(2);
    expect(editor.currentCounts()).toEqual({ current: 2, total: 2 });
    // Another query counts again.
    expect(editor.searchText("omega", opts)).toEqual({ current: 1, total: 1 });
  });

  it("reports nothing without a query", async () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n");
    typeOnFirstLine(view, " zeta");
    view.dispatch({ selection: { anchor: 0 } });
    await settle();
    expect(onFindChange).not.toHaveBeenCalled();

    editor.searchText("zeta", opts);
    await settle();
    onFindChange.mockClear();
    editor.clearSearch();
    typeOnFirstLine(view, " zeta");
    view.dispatch({ selection: { anchor: 0 } });
    await settle();
    expect(onFindChange).not.toHaveBeenCalled();
  });
});
