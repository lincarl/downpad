// @vitest-environment jsdom
// Crepe's table view had ProseMirror draw a table again, with new cells, when
// only the selection in it changed. These tests use the real editor to check
// that Downpad's table view keeps the cells then, unless a whole row or column
// is selected, whose menu Crepe's new view opens, and that it closes a row or
// column menu once its selection is gone.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
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

/** Wait for the next frame, in which a new Crepe table view opens the menu of
 *  a selected row or column. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Mount the document editor on the table document and return its view, once
 *  the table view has done what it does a frame after it is drawn. */
async function open() {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  await nextFrame();
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

/** Replace the whole document with a fresh parse of the same text, as
 *  Milkdown's replaceAll does. The table that comes back says the same but is
 *  made of new nodes, and the replace ends a cell selection. */
function replaceWithSame(view: EditorView): void {
  const doc = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(parserCtx)(markdown);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
}

/** The open state of the row or column menu, `role` being its handle's. */
function menuShows(role: "col-drag-handle" | "row-drag-handle"): string | undefined {
  return document.querySelector<HTMLElement>(`[data-role="${role}"] .button-group`)?.dataset.show;
}

describe("Downpad's table view", () => {
  it("keeps the cells when a cell selection ends, so a press on a cell still lands", { timeout: 60_000 }, async () => {
    const view = await open();
    const cells = cellPositions(view.state.doc);
    // "short text" and "a2", which make neither a whole row nor a whole column.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[4]!)));
    expect(document.querySelectorAll(".selectedCell")).toHaveLength(2);
    let paragraph = cellParagraph("short text");
    // A change that replaces the whole document with the same text ends the
    // cell selection.
    replaceWithSame(view);
    expect(document.querySelectorAll(".selectedCell")).toHaveLength(0);
    expect(paragraph.isConnected).toBe(true);
    // Changing only the selection keeps the cells too.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[4]!)));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(paragraph.isConnected).toBe(true);
    // Selecting both body rows draws the table again, and a replace that ends
    // that selection keeps the new cells.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[5]!)));
    expect(document.querySelectorAll(".selectedCell")).toHaveLength(4);
    paragraph = cellParagraph("short text");
    replaceWithSame(view);
    expect(paragraph.isConnected).toBe(true);
    expect(editor!.getMarkdown()).toBe(markdown);
  });

  it("opens the menu of a whole row or column once it is selected, and closes it once that selection ends", { timeout: 60_000 }, async () => {
    const view = await open();
    const cells = cellPositions(view.state.doc);
    // Selecting the first column, as a click on its handle or on the button
    // that adds a column does, draws the table again, and Crepe's new view
    // opens the column's menu.
    view.dispatch(view.state.tr.setSelection(CellSelection.colSelection(view.state.doc.resolve(cells[0]!))));
    await nextFrame();
    expect(menuShows("col-drag-handle")).toBe("true");
    // Cells that make no whole column close the menu.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[2]!)));
    expect(menuShows("col-drag-handle")).toBe("false");
    // A whole row opens the row's menu, and a caret closes it.
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[2]!, cells[3]!)));
    await nextFrame();
    expect(menuShows("row-drag-handle")).toBe("true");
    expect(menuShows("col-drag-handle")).toBe("false");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(menuShows("row-drag-handle")).toBe("false");
  });

  it("closes a column menu when a change to the table's content ends the column selection", { timeout: 60_000 }, async () => {
    const view = await open();
    const cells = cellPositions(view.state.doc);
    view.dispatch(view.state.tr.setSelection(CellSelection.colSelection(view.state.doc.resolve(cells[0]!))));
    await nextFrame();
    expect(menuShows("col-drag-handle")).toBe("true");
    // Aligning the column, as the menu's own buttons do, changes the table and
    // keeps the column selected, so the menu stays open.
    const align = view.state.tr;
    for (const cell of [cells[0]!, cells[2]!, cells[4]!]) align.setNodeAttribute(cell, "alignment", "center");
    view.dispatch(align);
    expect(view.state.selection instanceof CellSelection && view.state.selection.isColSelection()).toBe(true);
    expect(menuShows("col-drag-handle")).toBe("true");
    // The split's sync after a Markdown edit of a cell replaces the document
    // with the edited text, which ends the column selection.
    const menu = document.querySelector('[data-role="col-drag-handle"] .button-group');
    editor!.setMarkdown(markdown.replace("| a2 |", "| a2x |"));
    expect(menu?.isConnected).toBe(true);
    expect(menuShows("col-drag-handle")).toBe("false");
  });
});
