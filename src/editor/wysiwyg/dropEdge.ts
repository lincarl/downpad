// Where something dropped on the document goes in (§5.4). While something is
// dragged over the document, Crepe's drop indicator (prosemirror-drop-indicator)
// draws a line at the block edge nearest the pointer, and Crepe puts what is
// dropped in there. Those edges include the ones between a table's rows and
// cells. Put in there, a dragged block cut the table in two or pulled a cell
// out into a new table. So a drop whose nearest edge is inside a table goes in
// above or below the whole table, at the table's edge nearer the pointer, and
// the indicator draws its line there. That holds for blocks and text dragged
// within the document, text dragged in from elsewhere (`dropAtEdge`,
// `tableDropIndicator`), and dropped files (fileDrop.ts).
//
// Crepe's indicator also finds the edge for a drop again only once the pointer
// has moved, so after the page scrolled under a still pointer it put the drop
// in at the edge that had been under the pointer before the scroll, such as
// one between a table's rows. So md-easy finds the edge for every drop itself,
// from the page as it is at the drop (`dropAtEdge`).

import { dropIndicatorState, type DropIndicatorState } from "@milkdown/kit/plugin/cursor";
import type { Slice } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** The line the drop indicator draws, from one viewport point to another. */
type Line = NonNullable<DropIndicatorState>["line"];

/** A place where a drop goes in, as a document position at a block edge, with
 *  the line the drop indicator draws there. */
interface Edge {
  pos: number;
  line: Line;
}

/** The parts of the editor's view that find a block edge on the page. */
type LaidOut = Pick<EditorView, "state" | "nodeDOM">;

/** The line along the top or bottom edge of a block's box on the page. */
const lineAt = ({ left, right }: DOMRect, y: number): Line => ({ p1: { x: left, y }, p2: { x: right, y } });

/**
 * The block edge nearest a viewport point, as Crepe's drop indicator picks it:
 * the top or bottom edge of any block, lists, tables and their parts included,
 * by the distance from the point to the nearer end of the edge. On a tie the
 * earlier position wins. Null when no block is rendered.
 */
export function nearestBlockEdge(view: LaidOut, x: number, y: number): Edge | null {
  const nearest: { edge: Edge | null; distance: number } = { edge: null, distance: Infinity };
  const consider = (pos: number, box: DOMRect, edgeY: number): void => {
    const distance = Math.min(Math.abs(x - box.left), Math.abs(x - box.right)) + Math.abs(y - edgeY);
    if (distance < nearest.distance || (distance === nearest.distance && pos < (nearest.edge?.pos ?? Infinity))) {
      Object.assign(nearest, { edge: { pos, line: lineAt(box, edgeY) }, distance });
    }
  };
  view.state.doc.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const box = dom.getBoundingClientRect();
      consider(pos, box, box.top);
      consider(pos + node.nodeSize, box, box.bottom);
    }
    // A text block's children are inline, so only containers are searched.
    return !node.isTextblock;
  });
  return nearest.edge;
}

/**
 * Where a drop goes in instead of at `pos` when `pos` is inside a table: before
 * the table or after it, at whichever of its top and bottom edges is nearer the
 * viewport height `y`. Null when `pos` is not inside a table, or the table is
 * not rendered.
 */
export function tableEdge(view: LaidOut, pos: number, y: number): Edge | null {
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole !== "table") continue;
    const dom = view.nodeDOM($pos.before(depth));
    if (!(dom instanceof HTMLElement)) return null;
    const box = dom.getBoundingClientRect();
    const above = y < (box.top + box.bottom) / 2;
    return { pos: above ? $pos.before(depth) : $pos.after(depth), line: lineAt(box, above ? box.top : box.bottom) };
  }
  return null;
}

/** The block edge where a drop at a viewport point goes in, found from the
 *  page as it is now: the one nearest the point (`nearestBlockEdge`), or for
 *  an edge inside a table, the table's nearer edge (`tableEdge`). Null when
 *  no block is rendered. */
export function dropEdge(view: LaidOut, x: number, y: number): Edge | null {
  const nearest = nearestBlockEdge(view, x, y);
  return nearest && (tableEdge(view, nearest.pos, y) ?? nearest);
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
 * ProseMirror `handleDrop` that puts dropped content in at the block edge where
 * a drop at the pointer goes in (`dropEdge`), found from the page as it is at
 * the drop. For an edge inside a table that is above or below the table, where
 * `tableDropIndicator` has the indicator draw its line, not between the
 * table's rows or cells. Crepe's indicator would put it in at the edge it found
 * when the pointer last moved, which is stale after the page scrolled under a
 * still pointer. Moved content leaves where it was, and content moved right
 * beside itself stays there. The content and the selection after it are as
 * Crepe's indicator leaves them. The page scrolls to show what went in when it
 * is out of view, as it can be at the far edge of a tall table.
 * Returns false for a drop with nothing to put in, such as a row dragged by
 * its handle, and where no block is rendered.
 */
export function dropAtEdge(view: EditorView, event: DragEvent, slice: Slice, move: boolean): boolean {
  if (!slice.content.size) return false;
  const edge = dropEdge(view, event.clientX, event.clientY);
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

/**
 * Whether ProseMirror, rather than Crepe's table view, takes the events of a
 * drag over a table (tableCellClicks.ts), and so puts its drop in above or
 * below the table. That holds for a drag ProseMirror tracks in
 * `view.dragging`, such as a block dragged by Crepe's block handle or selected
 * text, and for text dragged in from elsewhere, such as another app or the
 * Split view's Markdown pane. The table keeps the drags of its own row and
 * column handles, which carry no text, and drags of files, which the app takes
 * (fileDrop.ts).
 */
export function editorTakesDrag(view: Pick<EditorView, "dragging">, event: DragEvent): boolean {
  if (view.dragging) return true;
  const types = event.dataTransfer?.types ?? [];
  return !types.includes("Files") && (types.includes("text/plain") || types.includes("text/html"));
}

/** Whether something dropped at a dragover's point goes in at the drop
 *  indicator's line. A table keeps the drop of a drag that ProseMirror does
 *  not take there (`editorTakesDrag`), such as a row dragged by its handle.
 *  The app takes dropped files and puts them in at the line (fileDrop.ts). */
function dropsAtLine(view: EditorView, event: DragEvent): boolean {
  if (editorTakesDrag(view, event) || event.dataTransfer?.types.includes("Files")) return true;
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
 * the indicator just drew. Crepe's indicator finds its edge again only once
 * the pointer moves, so when the page scrolls under a still pointer, this
 * plugin moves the line to the edge where a drop at the pointer now goes in
 * (`dropEdge`). It moves only a line the indicator shows.
 */
export const tableDropIndicator = $prose(
  (ctx) =>
    new Plugin({
      view(view) {
        /** Where the pointer last dragged something over the document, and
         *  whether a drop there goes in at the line. Cleared by the drop. */
        let pointer: { x: number; y: number; atLine: boolean } | null = null;
        /** Move the shown line to `edge`, or hide it where a move would leave
         *  the dragged block where it is. */
        const showAt = (edge: Edge): void => {
          const shown = ctx.get(dropIndicatorState.key);
          if (shown) ctx.set(dropIndicatorState.key, view.dragging?.move && backInPlace(view, edge.pos) ? null : { ...shown, ...edge });
        };
        const onDragOver = (event: DragEvent): void => {
          pointer = { x: event.clientX, y: event.clientY, atLine: dropsAtLine(view, event) };
          const shown = ctx.get(dropIndicatorState.key);
          const edge = shown && pointer.atLine ? tableEdge(view, shown.pos, event.clientY) : null;
          if (edge) showAt(edge);
        };
        const onScroll = (): void => {
          const edge = pointer?.atLine ? dropEdge(view, pointer.x, pointer.y) : null;
          if (edge) showAt(edge);
        };
        const onDrop = (): void => {
          pointer = null;
        };
        view.dom.addEventListener("dragover", onDragOver);
        view.dom.addEventListener("drop", onDrop);
        // Scroll events do not bubble, but a listener on the document in the
        // capture phase hears those of every scrolled element.
        const { ownerDocument } = view.dom;
        ownerDocument.addEventListener("scroll", onScroll, true);
        return {
          destroy: () => {
            view.dom.removeEventListener("dragover", onDragOver);
            view.dom.removeEventListener("drop", onDrop);
            ownerDocument.removeEventListener("scroll", onScroll, true);
          },
        };
      },
    }),
);
