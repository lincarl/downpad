// The block of the document view nearest a point, and the position a drag
// at the point selects to.
//
// ProseMirror's `posAtCoords` gives the position before or after a block for
// a point beside the block's box, such as in the document's side padding,
// left of a list item's or a quote's text, or in a table cell's padding.
// Chromium's own drag selection takes the line at the point's height there
// instead. A drag that md-easy follows itself (`dragSelect` in shiftClicks.ts)
// selected to the start or end of the whole block, or, as a selection between
// blocks ends in the nearest text, to the end of the block before. After a
// press beside the middle of a quote, a move of a pixel selected the rest of
// the quote's paragraph, and the next key replaced it. The drag therefore
// takes the text block nearest the point, as a press in the side padding
// does (paddingPresses.ts), and the position there at the point moved into
// that block, which beside a line is the line's start or end.
//
// Below the last block, in the view's bottom padding, where a point on the
// page below the view comes moved to, the drag selects to the end of the
// document, where a press there puts the caret (paddingPresses.ts). With the
// last line at the point, a press below the end that moved a pixel or two
// before the release selected from the end to the point's place on that line,
// and the next key replaced the text in between.

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { belowContent } from "../../shell/pagePresses";

/** A rendered block of the document, with its position and its box. */
export interface Block {
  node: ProseNode;
  pos: number;
  box: DOMRect;
  /** Whether the block is a child of the document itself. */
  topLevel: boolean;
}

/** `value` kept between `min` and `max`. */
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** A child node of a block, with its document position and, once measured,
 *  its box, or null when it has no element. */
interface Child {
  node: ProseNode;
  pos: number;
  box?: DOMRect | null;
}

/**
 * The rendered child of `parent`, whose content starts at `start`, whose box
 * is nearest the point. Height counts first, so the block at the point's
 * height wins, and then the distance across, so the cell nearer the point
 * wins in a table row.
 *
 * ProseMirror finds a child's element by counting from the first child, so
 * measuring every child of a document with thousands of blocks took longer
 * than a frame on each move of a drag. The children lie in order down the
 * page, or side by side in a table row, so a binary search finds the first
 * child that ends at or below the point. The nearest is then that child, the
 * one before it, or one in the same row as either.
 */
function nearestChild(view: EditorView, parent: ProseNode, start: number, x: number, y: number): Omit<Block, "topLevel"> | null {
  const children: Child[] = [];
  parent.forEach((node, offset) => children.push({ node, pos: start + offset }));
  const boxOf = (index: number): DOMRect | null => {
    const child = children[index];
    if (!child) return null;
    if (child.box === undefined) {
      const dom = view.nodeDOM(child.pos);
      child.box = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
    }
    return child.box;
  };
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((boxOf(middle)?.bottom ?? y) < y) low = middle + 1;
    else high = middle;
  }
  /** Whether the child at `index` starts at the height of `box`, as the
   *  cells of a table row do. */
  const inRow = (index: number, box: DOMRect | null): boolean => !!box && Math.abs((boxOf(index)?.top ?? Infinity) - box.top) < 1;
  let first = low - 1;
  while (inRow(first - 1, boxOf(low - 1))) first--;
  let last = low;
  while (inRow(last + 1, boxOf(low))) last++;
  let nearest: (Omit<Block, "topLevel"> & { dx: number; dy: number }) | null = null;
  for (let index = Math.max(first, 0); index <= Math.min(last, children.length - 1); index++) {
    const box = boxOf(index);
    if (!box) continue;
    const dy = Math.max(box.top - y, y - box.bottom, 0);
    const dx = Math.max(box.left - x, x - box.right, 0);
    if (!nearest || dy < nearest.dy || (dy === nearest.dy && dx < nearest.dx)) nearest = { ...children[index], box, dx, dy };
  }
  return nearest;
}

/**
 * The text block, code block or block that takes no caret nearest the point.
 * It descends from the document through the child nearest the point at each
 * level, such as through a list, its item and the item's paragraph, or
 * through a table, its row and the cell nearer the point. Null for a document
 * with nothing rendered.
 */
export function nearestBlock(view: EditorView, x: number, y: number): Block | null {
  const { doc } = view.state;
  let parent: ProseNode = doc;
  let start = 0;
  for (;;) {
    const child = nearestChild(view, parent, start, x, y);
    if (!child) return null;
    if (child.node.isTextblock || child.node.isAtom) return { ...child, topLevel: parent === doc };
    parent = child.node;
    start = child.pos + 1;
  }
}

/** The point moved into `box`, a pixel inside its edges. */
function into(box: DOMRect, x: number, y: number): { left: number; top: number } {
  return { left: clamp(x, box.left + 1, box.right - 1), top: clamp(y, box.top + 1, box.bottom - 1) };
}

/** The position in the text block `block` that ProseMirror finds at the point
 *  moved into the block's lines. Beside a line that is the line's start or
 *  end, and above or below the block a place on its first or last line. The
 *  block's box can hold padding below its last line, where Chromium on Linux
 *  and macOS puts the caret at the line's end whatever the point's x, so the
 *  point goes between the top of the first line and the bottom of the last. */
export function textPosition(view: EditorView, { node, pos, box }: Block, x: number, y: number): number {
  const start = pos + 1;
  const end = pos + node.nodeSize - 1;
  const top = view.coordsAtPos(start, 1).top;
  const bottom = view.coordsAtPos(end, -1).bottom;
  const found = view.posAtCoords({ left: clamp(x, box.left + 1, box.right - 1), top: clamp(y, top + 1, bottom - 1) });
  if (found && found.pos >= start && found.pos <= end) return found.pos;
  return x < (box.left + box.right) / 2 ? start : end;
}

/** The position a drag at the point selects to (see the header). Below the
 *  last block it is the end of the document. In the text block nearest the
 *  point it is `textPosition`. At a code block or a block that takes no caret
 *  it is the position before or after the block that ProseMirror finds at the
 *  point moved into its box, as for a point on the block. Null for a document
 *  with nothing rendered. */
export function positionNear(view: EditorView, x: number, y: number): number | null {
  if (belowContent(view.dom, y)) return Selection.atEnd(view.state.doc).head;
  const block = nearestBlock(view, x, y);
  if (!block) return null;
  if (block.node.isTextblock && !block.node.type.spec.code) return textPosition(view, block, x, y);
  return view.posAtCoords(into(block.box, x, y))?.pos ?? null;
}
