// @vitest-environment jsdom
// A block or text dragged within the document and dropped on or beside a table
// goes in above or below the whole table, and the drop indicator draws its line
// there. Crepe's table view kept a drop on a cell from ProseMirror, and Crepe's
// indicator put a drop beside the table between its rows or cells. These tests
// use the real editor and ProseMirror's own drop handling, with a laid-out page,
// which jsdom cannot measure, given to its blocks.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { dropIndicatorState } from "@milkdown/kit/plugin/cursor";
import type { Node } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

// jsdom has no DragEvent, which Milkdown's upload plugin checks each drop against.
vi.stubGlobal("DragEvent", class DragEvent extends MouseEvent {});

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  // The drop indicator hides its line 30ms after a drop, which needs the editor.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** The Crepe editor behind the document editor. */
const crepeOf = (opened: WysiwygEditor) => (opened as unknown as { crepe: Crepe }).crepe;

/** A box on the page, from `left` to 600px. */
const box = (top: number, bottom: number, left = 0) => DOMRect.fromRect({ x: left, y: top, width: 600 - left, height: bottom - top });

const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n";

/** Mount the document editor on `markdown`, wait past its first frame, and
 *  return its view, with a box from 80px to 400px down the page. */
async function open(markdown: string): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const view = crepeOf(editor).editor.ctx.get(editorViewCtx);
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(box(80, 400));
  return view;
}

/** Give each node that `matches` a box on the page between `top` and `bottom`,
 *  from `left` to 600px, in document order, one box per entry. */
function place(view: EditorView, matches: (node: Node) => boolean, boxes: [top: number, bottom: number][], left = 0): void {
  const queue = [...boxes];
  view.state.doc.descendants((node, pos) => {
    if (queue.length && matches(node)) {
      const [top, bottom] = queue.shift()!;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) throw new Error(`No element for ${node.type.name}`);
      vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(box(top, bottom, left));
    }
    return true;
  });
  if (queue.length) throw new Error("Fewer blocks than boxes");
}

/** A node of `type`, holding `text` when given. */
const nodeOf = (type: string, text?: string) => (node: Node) =>
  node.type.name === type && (text === undefined || node.textContent === text);

/** Whether a node is a row of a table. */
const isRow = (node: Node) => node.type.spec.tableRole === "row";

/** Lay out the page: each paragraph outside the table in turn, 20px high with
 *  10px between, from `start` down, then the table, starting 10px below the
 *  last of them, with a row every 40px from 40px in from the left. The cells
 *  and the paragraphs in them keep jsdom's empty box at the page's top left,
 *  far from every drop. */
function layOut(view: EditorView, before: string[], after: string[], start = 100): { top: number; bottom: number } {
  let y = start;
  for (const text of before) {
    place(view, nodeOf("paragraph", text), [[y, y + 20]]);
    y += 30;
  }
  const top = y;
  place(view, nodeOf("table"), [[top, top + 120]], 40);
  place(view, isRow, [[top, top + 40], [top + 40, top + 80], [top + 80, top + 120]], 40);
  y = top + 130;
  for (const text of after) {
    place(view, nodeOf("paragraph", text), [[y, y + 20]]);
    y += 30;
  }
  return { top, bottom: top + 120 };
}

/** The position before the first node that `matches`. */
function positionOf(view: EditorView, matches: (node: Node) => boolean): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && matches(node)) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error("No such node");
  return found;
}

/** Start dragging the paragraph that holds `text` by Crepe's block handle,
 *  which selects it and puts it on `view.dragging` with its selection. */
function dragBlock(view: EditorView, text: string): void {
  const selection = NodeSelection.create(view.state.doc, positionOf(view, nodeOf("paragraph", text)));
  view.dispatch(view.state.tr.setSelection(selection));
  const dragging = { slice: selection.content(), move: true, node: selection };
  view.dragging = dragging;
}

/** Start dragging the selected `word` of the paragraph that holds it, as
 *  ProseMirror does for a drag of selected text. */
function dragWord(view: EditorView, word: string): void {
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.includes(word)) from = pos + node.text.indexOf(word);
    return from < 0;
  });
  const selection = TextSelection.create(view.state.doc, from, from + word.length);
  view.dispatch(view.state.tr.setSelection(selection));
  view.dragging = { slice: selection.content(), move: true };
}

/** The data a drag of a block or text within the document carries, which
 *  ProseMirror reads from `view.dragging` instead. */
const DRAGGED = { "text/html": "", "text/plain": "" };

/** The data a drag of text from another app carries. */
const EXTERNAL = { "text/plain": "EXTERNAL" };

/** A drag event of `type` at a viewport point, carrying `data` by type. */
function dragEvent(type: string, x: number, y: number, data: Record<string, string> = DRAGGED): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  const dataTransfer = { types: Object.keys(data), files: [], getData: (format: string) => data[format] ?? "", setData: () => {}, clearData: () => {}, dropEffect: "move" };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

/** Drop what is dragged, or `data`, on `target` at a viewport point. jsdom
 *  cannot find the document position under a point, so it is the start of
 *  `target`'s node. */
function drop(view: EditorView, target: Element, x: number, y: number, data?: Record<string, string>): void {
  vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: view.posAtDOM(target, 0), inside: -1 });
  target.dispatchEvent(dragEvent("drop", x, y, data));
}

/** The paragraph element of the cell that holds `text`. */
function cellParagraph(text: string): HTMLElement {
  const paragraph = Array.from(document.querySelectorAll<HTMLElement>("td p, th p")).find((p) => p.textContent === text);
  if (!paragraph) throw new Error(`No cell holds "${text}"`);
  return paragraph;
}

describe("something dragged within the document", () => {
  it("has its dragenter on a table cell cancelled, so the browser never drops it into the cell itself", async () => {
    const view = await open(`Move me.\n\n${TABLE}`);
    dragBlock(view, "Move me.");
    const enter = dragEvent("dragenter", 300, 250);
    cellParagraph("4").dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("goes in below a table when dropped on the lower half of a cell, and leaves where it was", async () => {
    const view = await open(`Intro.\n\nMove me.\n\n${TABLE}\nEnd.\n`);
    layOut(view, ["Intro.", "Move me."], ["End."]);
    dragBlock(view, "Move me.");
    // On the "4" cell, in the table's lower half.
    drop(view, cellParagraph("4"), 300, 250);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\n${TABLE}\nMove me.\n\nEnd.\n`);
    expect(view.dragging).toBeNull();
  });

  it("goes in at a table's nearer edge when dropped in the margin beside its rows", async () => {
    const view = await open(`Move me.\n\nIntro.\n\n${TABLE}\nEnd.\n`);
    // Rows from 160px: the header row, then "1 | 2" from 200px.
    layOut(view, ["Move me.", "Intro."], ["End."]);
    dragBlock(view, "Move me.");
    // Left of the table, at the top of the "1 | 2" row, in the table's upper
    // half. The nearest edge is between the header row and that row.
    drop(view, view.dom, 10, 204);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\nMove me.\n\n${TABLE}\nEnd.\n`);
  });

  it("stays where it is when dropped beside itself", async () => {
    const view = await open(`Intro.\n\nMove me.\n\n${TABLE}\nEnd.\n`);
    layOut(view, ["Intro.", "Move me."], ["End."]);
    dragBlock(view, "Move me.");
    // Left of the table, at the top of the "1 | 2" row, in the table's upper
    // half, so above the table, right below the block.
    drop(view, view.dom, 10, 204);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\nMove me.\n\n${TABLE}\nEnd.\n`);
  });

  it("goes in between other blocks at the nearest edge as before", async () => {
    const view = await open(`Move me.\n\nIntro.\n\n${TABLE}\nEnd.\n`);
    layOut(view, ["Move me.", "Intro."], ["End."]);
    dragBlock(view, "Move me.");
    // Low at the left end of "End.", which starts at 290px, nearest its
    // bottom edge.
    drop(view, view.dom, 5, 308);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\n${TABLE}\nEnd.\n\nMove me.\n`);
  });

  it("goes in at the edge under the pointer at the drop after the page scrolled under the still pointer", async () => {
    const view = await open(`Move me.\n\nIntro.\n\n${TABLE}\nEnd.\n\nAfter.\n`);
    layOut(view, ["Move me.", "Intro."], ["End.", "After."]);
    dragBlock(view, "Move me.");
    // Left of the table, at the top of the "1 | 2" row. The drop indicator
    // finds the edge between the header row and that row there.
    view.dom.dispatchEvent(dragEvent("dragover", 10, 204));
    // The page scrolls 100px under the still pointer, which brings the lower
    // half of "End.", now from 190px to 210px, under it. The indicator kept
    // the edge it found before, between the table's rows, for the same point.
    layOut(view, ["Move me.", "Intro."], ["End.", "After."], 0);
    drop(view, view.dom, 10, 204);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\n${TABLE}\nEnd.\n\nMove me.\n\nAfter.\n`);
  });

  it("goes in as text of its own line below a table when selected text is dropped on a cell", async () => {
    const view = await open(`Intro with WORD here.\n\n${TABLE}\nEnd.\n`);
    layOut(view, ["Intro with WORD here."], ["End."]);
    dragWord(view, "WORD");
    drop(view, cellParagraph("4"), 300, 230);
    expect(editor!.getMarkdown()).toBe(`Intro with  here.\n\n${TABLE}\nWORD\n\nEnd.\n`);
  });
});

describe("text dragged in from another app", () => {
  it("has its dragenter on a table cell cancelled, so the browser never drops it into the cell itself", async () => {
    await open(`Intro.\n\n${TABLE}`);
    const enter = dragEvent("dragenter", 300, 250, EXTERNAL);
    cellParagraph("4").dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("goes in below a table when dropped on the lower half of a cell, as it does beside the table", async () => {
    const view = await open(`Intro.\n\n${TABLE}\nEnd.\n`);
    // The table from 130px to 250px, with the "3 | 4" row from 210px.
    layOut(view, ["Intro."], ["End."]);
    drop(view, cellParagraph("4"), 300, 230, EXTERNAL);
    expect(editor!.getMarkdown()).toBe(`Intro.\n\n${TABLE}\nEXTERNAL\n\nEnd.\n`);
  });
});

describe("a table", () => {
  it("keeps a drag that carries no text, such as a row dragged by its handle, or one that carries files", async () => {
    await open(`Intro.\n\n${TABLE}`);
    const drags: Record<string, string>[] = [{}, { Files: "", "text/plain": "a.csv" }];
    for (const data of drags) {
      // The table cancels dragover but not dragenter, as Crepe's does.
      const enter = dragEvent("dragenter", 300, 250, data);
      cellParagraph("4").dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
    }
  });
});

describe("the drop indicator", () => {
  /** Drag over `target` at a viewport point, carrying `data`, and return
   *  where the indicator then shows. */
  function dragOver(target: Element, x: number, y: number, data?: Record<string, string>) {
    target.dispatchEvent(dragEvent("dragover", x, y, data));
    return crepeOf(editor!).editor.ctx.get(dropIndicatorState.key);
  }

  it("draws its line at a table's nearer edge for a block or files dragged onto the table or beside it", async () => {
    const view = await open(`Move me.\n\nIntro.\n\n${TABLE}\nEnd.\n`);
    const { top, bottom } = layOut(view, ["Move me.", "Intro."], ["End."]);
    const table = positionOf(view, nodeOf("table"));
    const after = table + view.state.doc.nodeAt(table)!.nodeSize;
    dragBlock(view, "Move me.");
    // On the "4" cell near the bottom of the "1 | 2" row, in the lower half.
    expect(dragOver(cellParagraph("4"), 300, 237)).toMatchObject({ pos: after, line: { p1: { x: 40, y: bottom }, p2: { x: 600, y: bottom } } });
    // In the margin, near the top of the "1 | 2" row, in the upper half.
    expect(dragOver(view.dom, 10, 203)).toMatchObject({ pos: table, line: { p1: { y: top }, p2: { y: top } } });
    view.dragging = null;
    // Files from the desktop, which the app puts in at the line.
    expect(dragOver(cellParagraph("4"), 300, 238, { Files: "" })).toMatchObject({ pos: after });
  });

  it("moves its line to the edge under a still pointer once the page scrolls under it", async () => {
    const view = await open(`Move me.\n\nIntro.\n\n${TABLE}\nEnd.\n\nAfter.\n`);
    const { top } = layOut(view, ["Move me.", "Intro."], ["End.", "After."]);
    dragBlock(view, "Move me.");
    // Left of the table, at the top of the "1 | 2" row, in the table's upper half.
    expect(dragOver(view.dom, 10, 204)).toMatchObject({ pos: positionOf(view, nodeOf("table")), line: { p1: { y: top } } });
    // The page scrolls 100px, which brings the lower half of "End.", now from
    // 190px to 210px, under the pointer.
    layOut(view, ["Move me.", "Intro."], ["End.", "After."], 0);
    document.dispatchEvent(new Event("scroll"));
    const after = positionOf(view, nodeOf("paragraph", "After."));
    expect(crepeOf(editor!).editor.ctx.get(dropIndicatorState.key)).toMatchObject({ pos: after, line: { p1: { x: 0, y: 210 }, p2: { x: 600, y: 210 } } });
  });

  it("hides its line over the upper half of a table right below the dragged block, which a drop leaves where it is", async () => {
    const view = await open(`Intro.\n\nMove me.\n\n${TABLE}\nEnd.\n`);
    layOut(view, ["Intro.", "Move me."], ["End."]);
    dragBlock(view, "Move me.");
    // Over the lower half, the line shows below the table.
    expect(dragOver(cellParagraph("4"), 300, 237)).not.toBeNull();
    // Over the upper half, above the table, the block would stay where it is.
    expect(dragOver(cellParagraph("2"), 300, 205)).toBeNull();
  });

  it("draws its line at a table's nearer edge for text from another app dragged onto a cell, where a drop there goes in", async () => {
    const view = await open(`Intro.\n\n${TABLE}\nEnd.\n`);
    const { bottom } = layOut(view, ["Intro."], ["End."]);
    const table = positionOf(view, nodeOf("table"));
    const after = table + view.state.doc.nodeAt(table)!.nodeSize;
    // Over a cell near the bottom of the "1 | 2" row, which ends at 210px, in
    // the table's lower half.
    expect(dragOver(cellParagraph("4"), 300, 207, EXTERNAL)).toMatchObject({ pos: after, line: { p1: { y: bottom }, p2: { y: bottom } } });
  });
});
