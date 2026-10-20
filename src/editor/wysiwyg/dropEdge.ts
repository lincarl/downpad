// Where something dropped on the document goes in (§5.4), and the drop line
// that marks that place while something is dragged over the document.
//
// A drop goes in at the block edge nearest the pointer, as with Crepe's drop
// indicator (prosemirror-drop-indicator), with two exceptions. Crepe's edges
// include the ones between a table's rows and cells. Put in there, a dragged
// block cut the table in two or pulled a cell out into a new table. So a drop
// whose nearest edge is inside a table goes in above or below the whole table,
// at the table's edge nearer the pointer. Crepe also draws a fenced code
// block, math block or Mermaid diagram with a CodeMirror editor of its own,
// which took a block dragged onto it into the code as text and left the block
// where it was too. So what ProseMirror drags, a block or selected text, goes
// in above or below a code block it is dropped on, at the block's edge nearer
// the pointer (`codeBlockDrops`). Text dragged in from elsewhere, such as
// another app, still goes into the code at the pointer. The same edges hold
// for blocks and text dragged within the document, text dragged in from
// elsewhere (`dropAtEdge`), and dropped files (fileDrop.ts).
//
// md-easy draws the drop line itself (`dropLine`), from the same measurement
// of the page as the drop, in place of Crepe's indicator plugin. That plugin
// found its edge again only for a dragover at a new point, and hid its line
// 30 ms after a dragleave unless a dragover followed. So when the page
// scrolled under a still pointer, its line stayed at its old place on the
// screen or hid, and its drop went in at the edge that had been under the
// pointer before the scroll, such as one between a table's rows.

import { dropIndicatorState, type DropIndicatorState } from "@milkdown/kit/plugin/cursor";
import type { Node as ProseNode, Slice } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** The drop line, from one viewport point to another. */
type Line = NonNullable<DropIndicatorState>["line"];

/** A place where a drop goes in, as a document position at a block edge, with
 *  the drop line there. */
interface Edge {
  pos: number;
  line: Line;
}

/** The parts of the editor's view that find a block edge on the page. */
type LaidOut = Pick<EditorView, "dom" | "state" | "nodeDOM">;

/** A rendered block, with its box on the page relative to the top left
 *  corner of the editor's box. */
interface Block {
  pos: number;
  node: ProseNode;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The rendered blocks of a document, lists, tables and their parts
 *  included, as laid out in an editor of the given size. */
interface Layout {
  doc: ProseNode;
  width: number;
  height: number;
  blocks: Block[];
  byPos: Map<number, Block>;
}

/** The layout last measured for each editor. */
const layouts = new WeakMap<LaidOut, Layout>();

/**
 * The rendered blocks of the editor's document, and where the editor's box
 * now starts on the page. Measuring every block takes long in a long
 * document, so a layout is kept until the document or the editor's size
 * changes, as Crepe's indicator kept its edges. A scroll moves the editor and
 * its blocks together, so it keeps the layout.
 */
function measure(view: LaidOut): { layout: Layout; left: number; top: number } {
  const { left, top, width, height } = view.dom.getBoundingClientRect();
  const { doc } = view.state;
  const kept = layouts.get(view);
  if (kept && kept.doc === doc && kept.width === width && kept.height === height) return { layout: kept, left, top };
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const box = dom.getBoundingClientRect();
      blocks.push({ pos, node, left: box.left - left, right: box.right - left, top: box.top - top, bottom: box.bottom - top });
    }
    // A text block's children are inline, so only containers are searched.
    return !node.isTextblock;
  });
  const layout = { doc, width, height, blocks, byPos: new Map(blocks.map((block) => [block.pos, block])) };
  layouts.set(view, layout);
  return { layout, left, top };
}

/**
 * The block edge where a drop at a viewport point goes in, found from the
 * page as it is now. On a code block, a math block or a Mermaid diagram, with
 * its toolbar and preview, that is the block's top or bottom edge, whichever
 * is nearer the point. Elsewhere it is the block edge nearest the point, as
 * Crepe's drop indicator picks it: the top or bottom edge of any block, by the
 * distance from the point to the nearer end of the edge, with the earlier
 * position on a tie. When that edge is inside a table, it is the table's top
 * or bottom edge, whichever is nearer the point. Null when no block is
 * rendered.
 */
export function dropEdge(view: LaidOut, x: number, y: number): Edge | null {
  const { layout, left, top } = measure(view);
  const px = x - left;
  const py = y - top;
  const edgeOf = (pos: number, block: Block, edgeY: number): Edge => ({
    pos,
    line: { p1: { x: block.left + left, y: edgeY + top }, p2: { x: block.right + left, y: edgeY + top } },
  });
  /** The edge of `block` nearer the point. */
  const beside = (block: Block): Edge =>
    py < (block.top + block.bottom) / 2 ? edgeOf(block.pos, block, block.top) : edgeOf(block.pos + block.node.nodeSize, block, block.bottom);

  const code = layout.blocks.find((block) => block.node.type.spec.code && block.left <= px && px <= block.right && block.top <= py && py <= block.bottom);
  if (code) return beside(code);

  let nearest: Edge | null = null;
  let nearestDistance = Infinity;
  for (const block of layout.blocks) {
    const across = Math.min(Math.abs(px - block.left), Math.abs(px - block.right));
    for (const [pos, edgeY] of [[block.pos, block.top], [block.pos + block.node.nodeSize, block.bottom]]) {
      const distance = across + Math.abs(py - edgeY);
      if (distance < nearestDistance || (distance === nearestDistance && nearest && pos < nearest.pos)) {
        nearest = edgeOf(pos, block, edgeY);
        nearestDistance = distance;
      }
    }
  }
  if (!nearest) return null;

  const $pos = layout.doc.resolve(nearest.pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole === "table") {
      const table = layout.byPos.get($pos.before(depth));
      return table ? beside(table) : nearest;
    }
  }
  return nearest;
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

/** The key held while dragging to copy rather than move, as ProseMirror reads
 *  it: Option on macOS, Ctrl elsewhere. */
const copyKey = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "altKey" : "ctrlKey";

/**
 * Whether a drop at `event` would move what ProseMirror drags rather than copy
 * it, by ProseMirror's own rule for each drop: a `dragCopies` prop decides, or
 * else the drop copies while Ctrl, or Option on macOS, is held. Crepe's block
 * handle marks every drag it starts as a move in `view.dragging`, but
 * ProseMirror ignores that at the drop.
 */
export function dragMoves(view: EditorView, event: DragEvent): boolean {
  let copies: boolean | undefined;
  view.someProp("dragCopies", (test) => {
    copies = copies || test(event);
  });
  return copies === undefined ? !event[copyKey] : !copies;
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
 * the drop, where `dropLine` draws the drop line. On a code block, or for an
 * edge inside a table, that is above or below the code block or table, not
 * into the code or between the table's rows or cells. `codeBlockDrops` also
 * calls it for a drop on a code block, which ProseMirror never hears. Moved
 * content leaves where it was, and content moved right beside itself stays
 * there. The content and the selection after it are as ProseMirror leaves
 * them. The page scrolls to show what went in when it is out of view, as it
 * can be at the far edge of a tall table. Returns false for a drop with
 * nothing to put in, such as a row dragged by its handle, and where no block
 * is rendered.
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

/** The element an event happened on, or the element that holds the text node
 *  it happened on. */
function targetElement(event: Event): Element | null {
  const { target } = event;
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

/** Whether an event happened on a code block in the document, which Crepe
 *  draws with a CodeMirror editor of its own and with a toolbar and preview. */
function onCodeBlock(view: EditorView, event: Event): boolean {
  const block = targetElement(event)?.closest(".milkdown-code-block");
  return !!block && view.dom.contains(block);
}

/** Whether something dropped at a drag event's point goes in at the drop
 *  line. That holds for what ProseMirror drags, and for files, which the app
 *  puts in at the line (fileDrop.ts). A code block's editor takes text
 *  dragged in from elsewhere into the code, and a table keeps the drop of a
 *  drag that ProseMirror does not take there (`editorTakesDrag`), such as a
 *  row dragged by its handle. */
function dropsAtLine(view: EditorView, event: DragEvent): boolean {
  if (view.dragging || event.dataTransfer?.types.includes("Files")) return true;
  if (onCodeBlock(view, event)) return false;
  return editorTakesDrag(view, event) || !targetElement(event)?.closest(".milkdown-table-block");
}

/** Whether two states of the drop line draw the same line at the same place. */
function sameLine(a: DropIndicatorState, b: DropIndicatorState): boolean {
  if (!a || !b) return a === b;
  const [p, q] = [a.line, b.line];
  return a.pos === b.pos && p.p1.x === q.p1.x && p.p1.y === q.p1.y && p.p2.x === q.p2.x && p.p2.y === q.p2.y;
}

/** Where the pointer last dragged something over the document, whether a
 *  drop there goes in at the drop line, and whether it moves what ProseMirror
 *  drags. */
interface DragPoint {
  x: number;
  y: number;
  atLine: boolean;
  moves: boolean;
}

/**
 * A plugin that draws the drop line while something is dragged over the
 * document, at the block edge where a drop at the pointer goes in
 * (`dropEdge`), the edge that `dropAtEdge` and file drops use. It takes the
 * place of Crepe's indicator plugin, which the editor removes, and draws with
 * Crepe's indicator state and element.
 *
 * The line follows each dragenter and dragover on the document, and each
 * scroll while a drag is over the document, since the page can scroll under
 * a still pointer, by Crepe's scroll at the editor's edge or by the wheel.
 * Chromium then sends only a dragenter and a dragleave when the element under
 * the pointer changes. The line hides where a move would leave the dragged
 * block or selection where it is, but not for a drag that the keys held make
 * a copy (`dragMoves`). It hides where a drop does not go in at the line,
 * such as text from another app over a code block, whose editor shows its own
 * drop cursor. It also hides once the drag leaves the document, and at a drop
 * or the end of a drag anywhere in the window, including a file drop that the
 * app takes before the editor hears it.
 */
export const dropLine = $prose(
  (ctx) =>
    new Plugin({
      view(view) {
        let point: DragPoint | null = null;
        const draw = (): void => {
          const edge = point?.atLine && view.editable ? dropEdge(view, point.x, point.y) : null;
          const state: DropIndicatorState = edge && !(point?.moves && backInPlace(view, edge.pos)) ? { view, ...edge } : null;
          if (!sameLine(ctx.get(dropIndicatorState.key), state)) ctx.set(dropIndicatorState.key, state);
        };
        const end = (): void => {
          point = null;
          draw();
        };
        const onDrag = (event: DragEvent): void => {
          const moves = view.dragging !== null && dragMoves(view, event);
          point = { x: event.clientX, y: event.clientY, atLine: dropsAtLine(view, event), moves };
          draw();
        };
        /** End the line when the drag leaves the document for an element
         *  outside it, or leaves the window, where Chromium gives no element. */
        const onLeave = (event: DragEvent): void => {
          const to = event.relatedTarget;
          if (point && !(to instanceof Node && view.dom.contains(to))) end();
        };
        const onScroll = (): void => {
          if (point) draw();
        };
        // All in the capture phase, so no element that stops an event keeps
        // it from the line. Scroll events do not bubble, but the document
        // hears those of every scrolled element in the capture phase.
        const listening = new AbortController();
        const options = { capture: true, signal: listening.signal };
        const { ownerDocument } = view.dom;
        view.dom.addEventListener("dragenter", onDrag, options);
        view.dom.addEventListener("dragover", onDrag, options);
        view.dom.addEventListener("dragleave", onLeave, options);
        ownerDocument.addEventListener("drop", end, options);
        ownerDocument.addEventListener("dragend", end, options);
        ownerDocument.addEventListener("scroll", onScroll, options);
        return { destroy: () => listening.abort() };
      },
    }),
);

/**
 * A plugin that puts what ProseMirror drags in above or below a code block
 * it is dropped on (`dropAtEdge`), rather than into the code.
 *
 * Crepe's code block view keeps every event on it from ProseMirror. Its
 * CodeMirror editor put the text of a dragged block or selection into the
 * code, and left the block or selection where it was, since it deletes only
 * text dragged from within itself. Over its toolbar or preview no one took
 * the drop. For a drag that ProseMirror tracks in `view.dragging`, this plugin
 * cancels each drag event on a code block before CodeMirror hears it, which
 * has CodeMirror ignore the event and allows the drop there, and puts the drop
 * in itself, as ProseMirror would. Text dragged in from elsewhere still goes
 * into the code.
 */
export const codeBlockDrops = $prose(
  () =>
    new Plugin({
      view(view) {
        /** Cancel the drag events that ProseMirror's drag has on a code block,
         *  in the capture phase, and put its drop in beside the block. */
        const onCodeBlockDrag = (event: DragEvent): void => {
          const { dragging } = view;
          if (!dragging || !onCodeBlock(view, event)) return;
          event.preventDefault();
          if (event.type !== "drop") return;
          let { slice } = dragging;
          view.someProp("transformPasted", (transform) => {
            slice = transform(slice, view, false);
          });
          try {
            dropAtEdge(view, event, slice, dragMoves(view, event));
          } finally {
            // As ProseMirror does, end the drag once the drop is in, which
            // moves the block the drag holds rather than the selection.
            view.dragging = null;
          }
        };
        const listening = new AbortController();
        const options = { capture: true, signal: listening.signal };
        for (const type of ["dragenter", "dragover", "drop"] as const) view.dom.addEventListener(type, onCodeBlockDrag, options);
        return { destroy: () => listening.abort() };
      },
    }),
);
