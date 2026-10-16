// @vitest-environment jsdom
// The find card's count follows edits made while it is open (§5.13). These
// tests use the real document editor to check which changes it reports.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its find change reports. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; onFindChange: ReturnType<typeof vi.fn> }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onFindChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {}, onFindChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, onFindChange };
}

/** The editor's ProseMirror view, to type and undo as the user would. */
const viewOf = (opened: WysiwygEditor) =>
  (opened as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);

/** Type `text` at the end of the document. */
function typeAtEnd(opened: WysiwygEditor, text: string): void {
  const view = viewOf(opened);
  view.dispatch(view.state.tr.insertText(text, TextSelection.atEnd(view.state.doc).from));
}

describe("find count changes in the document view", () => {
  it("reports typing, undo and a split mirror sync with the new count", { timeout: 60_000 }, async () => {
    const { editor, onFindChange } = await open("Alpha zeta.\n\nOmega zeta.\n");
    expect(editor.search("zeta", opts)).toEqual({ current: 1, total: 2 });
    expect(onFindChange).not.toHaveBeenCalled();

    typeAtEnd(editor, " zeta");
    expect(onFindChange).toHaveBeenCalledOnce();
    expect(editor.currentCounts()).toEqual({ current: 1, total: 3 });

    const view = viewOf(editor);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(onFindChange).toHaveBeenCalledTimes(2);
    expect(editor.currentCounts()).toEqual({ current: 1, total: 2 });

    editor.setMarkdown("Alpha zeta.\n\nOmega zeta.\n\nzeta and zeta\n");
    expect(onFindChange).toHaveBeenCalledTimes(3);
    expect(editor.currentCounts()).toEqual({ current: 1, total: 4 });
  });

  it("reports a frontmatter table edit with the new count", { timeout: 60_000 }, async () => {
    const { editor, onFindChange } = await open("---\ntitle: zeta\n---\n\nAlpha zeta.\n");
    expect(editor.search("zeta", opts)).toEqual({ current: 1, total: 2 });
    const value = await vi.waitFor(() => {
      const cell = document.querySelector<HTMLElement>(".frontmatter-value-edit");
      if (!cell) throw new Error("The frontmatter table is not drawn yet");
      return cell;
    });
    // Let the table's first drawing report, so only the edit is left to report.
    await new Promise((resolve) => setTimeout(resolve, 100));
    onFindChange.mockClear();
    value.textContent = "zeta zeta";
    fireEvent.input(value);
    await vi.waitFor(() => expect(onFindChange).toHaveBeenCalled());
    expect(editor.currentCounts()).toEqual({ current: 1, total: 3 });
  });

  it("reports nothing without a query or when only the selection moves", { timeout: 60_000 }, async () => {
    const { editor, onFindChange } = await open("Alpha zeta.\n");
    typeAtEnd(editor, " zeta");

    editor.search("zeta", opts);
    const view = viewOf(editor);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    editor.findNext();

    editor.clearSearch();
    typeAtEnd(editor, " zeta");
    expect(onFindChange).not.toHaveBeenCalled();
    expect(editor.currentCounts()).toEqual({ current: 0, total: 0 });
  });
});
