// @vitest-environment jsdom
// Crepe's table view had ProseMirror draw a table again, with new cells, when
// only the selection in it changed. These tests use the real editor to check
// that md-easy's table view keeps the cells then, and still closes a row or
// column menu once its selection is gone.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const markdown = "Intro.\n\n| Name | Notes |\n| --- | --- |\n| short text | a note |\n| a2 | b2 |\n";

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on the table document and return its view. */
async function open() {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
}

/** The document positions of the table's cells, row by row. */
function cellPositions(doc: Node): number[] {
  const cells: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") cells.push(pos);
    return !node.isTextblock;
  });
  return cells;
}

/** The paragraph of the cell that holds `text`. */
function cellParagraph(text: string): HTMLParagraphElement {
  const paragraph = Array.from(document.querySelectorAll<HTMLParagraphElement>("td p, th p")).find((p) => p.textContent === text);
  if (!paragraph) throw new Error(`no cell holds "${text}"`);
  return paragraph;
}

describe("md-easy's table view", () => {
  it("keeps the cells when a cell selection ends, so a press on a cell still lands", { timeout: 60_000 }, async () => {
    const view = await open();
    const cells = cellPositions(view.state.doc);
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[5]!)));
    expect(document.querySelectorAll(".selectedCell")).toHaveLength(4);
    const paragraph = cellParagraph("short text");
    // The split's catch-up replaces the whole document with the same text, as
    // after a Markdown edit outside the table, which ends the cell selection.
    editor!.setMarkdown(markdown);
    expect(document.querySelectorAll(".selectedCell")).toHaveLength(0);
    expect(paragraph.isConnected).toBe(true);
    // Changing only the selection keeps the cells too.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[5]!)));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(paragraph.isConnected).toBe(true);
    expect(editor!.getMarkdown()).toBe(markdown);
  });

  it("closes a column menu once the column selection ends, and keeps it open while it lasts", { timeout: 60_000 }, async () => {
    const view = await open();
    const cells = cellPositions(view.state.doc);
    const menu = document.querySelector<HTMLElement>('[data-role="col-drag-handle"] .button-group');
    if (!menu) throw new Error("no column menu");
    // Select the first column and open its menu, as a click on its handle does.
    view.dispatch(view.state.tr.setSelection(CellSelection.colSelection(view.state.doc.resolve(cells[0]!))));
    menu.dataset.show = "true";
    // Another change of the highlights in the table leaves the menu open.
    view.dispatch(view.state.tr.setSelection(CellSelection.colSelection(view.state.doc.resolve(cells[4]!), view.state.doc.resolve(cells[0]!))));
    expect(menu.dataset.show).toBe("true");
    // A row selection is not a column, so the column menu's Delete would
    // remove the row. The menu closes.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[3]!)));
    expect(menu.dataset.show).toBe("false");
    view.dispatch(view.state.tr.setSelection(CellSelection.colSelection(view.state.doc.resolve(cells[0]!))));
    menu.dataset.show = "true";
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(menu.dataset.show).toBe("false");
  });
});
