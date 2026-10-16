// Where a file dropped on the document goes in (§5.4). While something is
// dragged over the document, Crepe's drop indicator (prosemirror-drop-indicator)
// draws a line at the block edge nearest the pointer, and Crepe inserts dropped
// blocks there. md-easy takes file drops before Crepe sees them, so it finds
// that edge the same way and inserts the file's Markdown there itself.

import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { GapCursor } from "@milkdown/kit/prose/gapcursor";
import { Slice, type Node } from "@milkdown/kit/prose/model";
import { Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { dropPoint } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";

/** Where the files of a drop on the document go in. The editor that made it
 *  keeps the position in step with later edits. */
export interface DropTarget {
  pos: number;
}

/**
 * Where a file dropped at a viewport point goes in, as a document position.
 * Over the document that is the block edge Crepe's drop indicator marks there.
 * The indicator does not show above or below the document, so a drop there
 * goes in at its start or end. Null when no block is rendered.
 */
export function dropPosition(view: Pick<EditorView, "dom" | "state" | "nodeDOM">, x: number, y: number): number | null {
  const { top, bottom } = view.dom.getBoundingClientRect();
  if (y < top) return 0;
  if (y > bottom) return view.state.doc.content.size;
  return nearestBlockEdge(view, x, y);
}

/**
 * The block edge nearest a viewport point, as Crepe's drop indicator picks it:
 * the top or bottom edge of any block, lists and their items included, by the
 * distance from the point to the nearer end of the edge. On a tie the earlier
 * position wins. Returns the document position at that edge, or null when no
 * block is rendered.
 */
function nearestBlockEdge(view: Pick<EditorView, "state" | "nodeDOM">, x: number, y: number): number | null {
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

/** Whether a node is an empty paragraph, a line with nothing typed on it. */
function isEmptyParagraph(node: Node | null | undefined): node is Node {
  return node?.type.name === "paragraph" && node.content.size === 0;
}

/** Where the last step of a transaction ends its change, in the new document. */
function changeEnd(tr: Transaction): number {
  let end = 0;
  tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  return end;
}

/**
 * Put a text caret after content just inserted, which ends at `end`, so typing
 * goes on after it. Inserted text keeps the caret right after it. After an
 * image the caret goes to the start of the next text. With no text after it,
 * it goes in the gap after the image, where typing starts a new line, and
 * where Crepe adds an empty last line at the end of the document. The image is
 * never left selected, where the next key would replace it.
 */
function placeCaret(tr: Transaction, end: number, endsInText: boolean): Transaction {
  const $end = tr.doc.resolve(end);
  if ($end.parent.inlineContent) return tr.setSelection(TextSelection.create(tr.doc, end));
  const before = Selection.findFrom($end, -1, true);
  if (endsInText && before) return tr.setSelection(before);
  const after = Selection.findFrom($end, 1, true);
  if (after) return tr.setSelection(after);
  const gap = $end.parent.contentMatchAt($end.index()).defaultType?.isTextblock;
  return tr.setSelection(gap ? new GapCursor($end) : before ?? Selection.near($end));
}

/**
 * Milkdown action that inserts Markdown's blocks at a drop target, as
 * ProseMirror inserts a block dropped there, and puts the caret after them
 * (`placeCaret`).
 * The blocks go in beside the blocks at that edge, never splitting one. Where
 * they cannot go, such as between table cells, they go in at the nearest
 * place outside that can hold them. An empty line at the edge takes them, as
 * typing on it would, so Crepe's empty last line never ends up mid-document,
 * where it would be saved as `<br />`. The target moves past the blocks, so
 * the next file of the drop follows.
 */
export function insertBlocksAt(markdown: string, target: DropTarget) {
  return (ctx: Ctx): void => {
    const view = ctx.get(editorViewCtx);
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc?.lastChild) return;
    const { tr } = view.state;
    const slice = new Slice(doc.content, 0, 0);
    const at = dropPoint(tr.doc, target.pos, slice) ?? target.pos;
    const { nodeBefore, nodeAfter } = tr.doc.resolve(at);
    let from = at;
    let to = at;
    if (isEmptyParagraph(nodeAfter)) to += nodeAfter.nodeSize;
    else if (isEmptyParagraph(nodeBefore)) from -= nodeBefore.nodeSize;
    const only = doc.childCount === 1 ? doc.firstChild : null;
    if (only) tr.replaceRangeWith(from, to, only);
    else tr.replaceRange(from, to, slice);
    if (!tr.docChanged) return;
    // The editor maps the target through this insert. From the end of the
    // replaced range, that takes it past the inserted blocks.
    target.pos = to;
    // Take the end from the step, which can have moved the insert to fit.
    view.dispatch(placeCaret(tr, changeEnd(tr), doc.lastChild.isTextblock).scrollIntoView());
  };
}

/**
 * Milkdown action that inserts Markdown at the selection, as Milkdown's
 * `insert` does, for a file dropped away from the document text (§5.4). The
 * caret then goes after it (`placeCaret`).
 */
export function insertAtSelection(markdown: string) {
  return (ctx: Ctx): void => {
    const view = ctx.get(editorViewCtx);
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc?.lastChild) return;
    const { tr } = view.state;
    const { openStart, openEnd } = tr.selection.content();
    tr.replaceSelection(new Slice(doc.content, openStart, openEnd));
    if (!tr.docChanged) return;
    view.dispatch(placeCaret(tr, changeEnd(tr), doc.lastChild.isTextblock).scrollIntoView());
  };
}
