// @vitest-environment jsdom
// The find card's count follows edits made while it is open (§5.13). These
// tests use the real Markdown editor to check which changes it reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// The recount waits on a timer. CodeMirror's measuring stays on real frames.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
  vi.useRealTimers();
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

/** How long edits and caret moves must pause before the Markdown view
 *  recounts (`FIND_RECOUNT_DELAY_MS`). */
const RECOUNT_DELAY_MS = 200;

/** Let that pause run out. */
const settle = () => vi.advanceTimersByTime(RECOUNT_DELAY_MS);

/** Type `text` at the end of the first line. */
function typeOnFirstLine(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: text } });
}

describe("find count changes in the Markdown view", () => {
  it("reports edits once they pause, with the new count", () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n\nOmega zeta.\n");
    expect(editor.searchText("zeta", opts)).toEqual({ current: 1, total: 2 });

    // Counting walks the whole document, so a burst of typing is counted once.
    typeOnFirstLine(view, " zeta");
    typeOnFirstLine(view, " zeta");
    vi.advanceTimersByTime(RECOUNT_DELAY_MS - 1);
    expect(onFindChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFindChange).toHaveBeenCalledOnce();
    // The selected match moves along with the edits and stays current.
    expect(editor.currentCounts()).toEqual({ current: 1, total: 4 });

    // A closed editor has nothing left to report.
    typeOnFirstLine(view, " zeta");
    editor.destroy();
    settle();
    expect(onFindChange).toHaveBeenCalledOnce();
  });

  it("reports a caret move, which can leave no match current", () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n\nOmega zeta.\n");
    expect(editor.searchText("zeta", opts)).toEqual({ current: 1, total: 2 });
    settle();
    onFindChange.mockClear();

    // A click on the empty line between the matches.
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    settle();
    expect(onFindChange).toHaveBeenCalledOnce();
    expect(editor.currentCounts()).toEqual({ current: 0, total: 2 });

    // CodeMirror's own find next (Ctrl+G) selects a match without the find card.
    findNext(view);
    settle();
    expect(onFindChange).toHaveBeenCalledTimes(2);
    expect(editor.currentCounts()).toEqual({ current: 2, total: 2 });
    // Another query counts again.
    expect(editor.searchText("omega", opts)).toEqual({ current: 1, total: 1 });
  });

  it("reports nothing without a query", () => {
    const { editor, view, onFindChange } = open("Alpha zeta.\n");
    typeOnFirstLine(view, " zeta");
    view.dispatch({ selection: { anchor: 0 } });
    settle();
    expect(onFindChange).not.toHaveBeenCalled();

    editor.searchText("zeta", opts);
    settle();
    onFindChange.mockClear();
    editor.clearSearch();
    typeOnFirstLine(view, " zeta");
    view.dispatch({ selection: { anchor: 0 } });
    settle();
    expect(onFindChange).not.toHaveBeenCalled();
  });
});
