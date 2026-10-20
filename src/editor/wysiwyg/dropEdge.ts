// Where something dropped on the document goes in (§5.4). While something is
// dragged over the document, Crepe's drop indicator (prosemirror-drop-indicator)
// draws a line at the block edge nearest the pointer, and Crepe puts what is
// dropped in there. Those edges include the ones between a table's rows and
// cells. Put in there, a dragged block cut the table in two or pulled a cell
// out into a new table. So a drop whose nearest edge is inside a table goes in
// above or below the whole table, at the table's edge nearer the pointer, and
// the indicator draws its line there. That holds for blocks and text dragged
// within the document (`dropBesideTable`, `tableDropIndicator`) and for
// dropped files (fileDrop.ts).

import { dropIndicatorState, type DropIndicatorState } from "@milkdown/kit/plugin/cursor";
import type { Slice } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** The line the drop indicator draws, from one viewport point to another. */
type Line = NonNullable<DropIndicatorState>["line"];

/** The parts of the editor's view that find a block edge on the page. */
type LaidOut = Pick<EditorView, "state" | "nodeDOM">;

/**
 * The block edge nearest a viewport point, as Crepe's drop indicator picks it:
 * the top or bottom edge of any block, lists, tables and their parts included,
 * by the distance from the point to the nearer end of the edge. On a tie the
 * earlier position wins. Returns the document position at that edge, or null
 * when no block is rendered.
 */
export function nearestBlockEdge(view: LaidOut, x: number, y: number): number | null {
  const nearest = { pos: -1, distance: Infinity };
  const consider = (pos: number, left: number, right: number, edge: number): void => {
    const distance = Math.min(Math.abs(x - left), Math.abs(x - right)) + Math.abs(y - edge);
    if (distance < nearest.distance || (distance === nearest.distance && pos < nearest.pos)) {
      Object.assign(nearest, { pos, distance });
    }
  };
  view.state.doc.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const { top, bottom, left, right } = dom.getBoundingClientRect();
      consider(pos, left, right, top);
      consider(pos + node.nodeSize, left, right, bottom);
    }
    // A text block's children are inline, so only containers are searched.
    return !node.isTextblock;
  });
  return nearest.pos < 0 ? null : nearest.pos;
}

/**
 * Where a drop goes in instead of at `pos` when `pos` is inside a table: before
 * the table or after it, at whichever of its top and bottom edges is nearer the
 * viewport height `y`, with the line the drop indicator draws at that edge.
 * Null when `pos` is not inside a table, or the table is not rendered.
 */
export function tableEdge(view: LaidOut, pos: number, y: number): { pos: number; line: Line } | null {
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole !== "table") continue;
    const dom = view.nodeDOM($pos.before(depth));
    if (!(dom instanceof HTMLElement)) return null;
    const { top, bottom, left, right } = dom.getBoundingClientRect();
    const above = y < (top + bottom) / 2;
    const edge = above ? top : bottom;
    return { pos: above ? $pos.before(depth) : $pos.after(depth), line: { p1: { x: left, y: edge }, p2: { x: right, y: edge } } };
  }
  return null;
}

/** The block edge where a drop at a viewport point goes in: the one nearest
 *  the point (`nearestBlockEdge`), or for an edge inside a table, the table's
 *  nearer edge (`tableEdge`). Null when no block is rendered. */
export function dropEdge(view: LaidOut, x: number, y: number): number | null {
  const pos = nearestBlockEdge(view, x, y);
  return pos === null ? null : (tableEdge(view, pos, y)?.pos ?? pos);
}

/** Where the last step of a transaction ends its change, in the new document. */
export function changeEnd(tr: Transaction): number {
  let end = 0;
  tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  return end;
}

/** The block that Crepe's block handle drags, which it puts on
 *  `view.dragging` as `node`, a field prosemirror-view's types leave out.
 *  Null for other drags, which move the selection. */
function draggedBlock(view: EditorView): NodeSelection | null {
  const node: unknown = view.dragging && Reflect.get(view.dragging, "node");
  return node instanceof NodeSelection ? node : null;
}

/** Whether moving what is dragged to `pos` would leave it where it is, since
 *  `pos` is at an end of the dragged block or selection, or inside it. */
function backInPlace(view: EditorView, pos: number): boolean {
  const { from, to } = draggedBlock(view) ?? view.state.selection;
  return from <= pos && pos <= to;
}

/**
 * ProseMirror `handleDrop` for a drop whose nearest block edge is inside a
 * table. It puts the dropped content in above or below the table, where
 * `tableDropIndicator` has the indicator draw its line, instead of where
 * Crepe's indicator would put it, between the table's rows or cells. Moved
 * content leaves where it was, and content moved right beside itself stays
 * there. The content and the selection after it are as at any other edge.
 * The edge of a tall table can be far from the pointer, out of view, so the
 * page then scrolls to show what went in. Returns false for a drop elsewhere,
 * which Crepe's indicator takes, and for a drop with nothing to put in, such
 * as a row dragged by its handle.
 */
export function dropBesideTable(view: EditorView, event: DragEvent, slice: Slice, move: boolean): boolean {
  if (!slice.content.size) return false;
  const nearest = nearestBlockEdge(view, event.clientX, event.clientY);
  const edge = nearest === null ? null : tableEdge(view, nearest, event.clientY);
  if (!edge) return false;
  if (move && backInPlace(view, edge.pos)) return true;
  const dragged = draggedBlock(view);
  const tr = view.state.tr;
  if (move) {
    if (dragged) dragged.replace(tr);
    else tr.deleteSelection();
  }
  const pos = tr.mapping.map(edge.pos);
  const block = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1 ? slice.content.firstChild : null;
  const before = tr.doc;
  if (block) tr.replaceRangeWith(pos, pos, block);
  else tr.replaceRange(pos, pos, slice);
  if (tr.doc.eq(before)) return true;
  const $pos = tr.doc.resolve(pos);
  if (block && NodeSelection.isSelectable(block) && $pos.nodeAfter?.sameMarkup(block)) {
    tr.setSelection(new NodeSelection($pos));
  } else {
    const $end = tr.doc.resolve(changeEnd(tr));
    tr.setSelection(view.someProp("createSelectionBetween", (create) => create(view, $pos, $end)) ?? TextSelection.between($pos, $end));
  }
  view.focus();
  view.dispatch(tr.setMeta("uiEvent", "drop").scrollIntoView());
  return true;
}

/** Whether something dropped at a dragover's point goes in at the drop
 *  indicator's line. A table keeps a drop on it from ProseMirror, unless
 *  ProseMirror started the drag (tableCellClicks.ts). The app takes dropped
 *  files and puts them in at the line (fileDrop.ts). */
function dropsAtLine(view: EditorView, event: DragEvent): boolean {
  if (view.dragging || event.dataTransfer?.types.includes("Files")) return true;
  const { target } = event;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !element?.closest(".milkdown-table-block");
}

/**
 * A plugin that has Crepe's drop indicator draw its line above or below a table
 * instead of inside it, at the edge where a drop there goes in (`tableEdge`).
 * As Crepe's indicator does for its own edges, it hides the line where a move
 * would leave the dragged block where it is. Use it after Crepe's Cursor
 * feature, so its listener runs after the indicator's own and moves the line
 * the indicator just drew.
 */
export const tableDropIndicator = $prose(
  (ctx) =>
    new Plugin({
      view(view) {
        const onDragOver = (event: DragEvent): void => {
          const shown = ctx.get(dropIndicatorState.key);
          if (!shown || !dropsAtLine(view, event)) return;
          const edge = tableEdge(view, shown.pos, event.clientY);
          if (edge) ctx.set(dropIndicatorState.key, view.dragging?.move && backInPlace(view, edge.pos) ? null : { ...shown, ...edge });
        };
        view.dom.addEventListener("dragover", onDragOver);
        return { destroy: () => view.dom.removeEventListener("dragover", onDragOver) };
      },
    }),
);
