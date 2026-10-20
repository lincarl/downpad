// A press in the document's side padding.
//
// Crepe pads the document view on each side, and a press there lands on the
// view's own element, beside the block at its height. ProseMirror leaves a
// plain press to Chromium. Beside a paragraph or a heading, Chromium puts the
// caret on the line pressed, at its start on the left and at its end on the
// right. Beside a block that is not editable text itself, such as a code
// block, a math block, a Mermaid diagram, an image on its own line, a table or
// a list item, whose bullet comes before its text, it put the caret before or
// after the whole block, by the half of the block pressed, and then moved it
// to the nearest place that takes a caret in the order of the page. That was
// the end of the text before the block, the start of the text after it, or
// the start of the document, often out of view, and the next key went there.
// Beside a code block at the start of the document it went into the code at
// its start, or, with text selected, nowhere, and the next key was lost.
//
// This plugin takes a press in the side padding beside anything but the lines
// of a paragraph or heading, in the capture phase, before ProseMirror and the
// other plugins see it. It puts the caret on the line at the press's height,
// as Chromium does beside a paragraph. In a list item or a quote that is a
// line of its text, and in a table a line of the row's first cell on the left
// and of its last cell on the right. A drag from there selects to the pointer.
// Beside a code block, a math block or a Mermaid diagram, the cursor goes to
// the start or end of the line of code at that height, or of the nearest
// line beside the block's toolbar or preview, and the code takes focus.
// Beside an image on its own line or a rule, which take no caret, the press
// selects it, as a click on it does. A press in the gap between two blocks
// goes to the nearer one.
//
// A Shift+press while the document has focus extends the selection to the
// line's start or end, as Chromium does beside a paragraph. Beside a code
// block, an image or a rule, and from outside the document, such as from the
// find card, the Markdown pane or a code block, a Shift+press is a plain one,
// as on those blocks themselves (shiftClicks.ts, codeMirrorPresses.ts).

import { EditorView as CodeMirror } from "@codemirror/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { dragSelect, selectedOnClick, selectThenFocus } from "./shiftClicks";

/** The side of the document's text column that a press is on. */
type Side = "left" | "right";

/** Where a press beside a block goes, as a selection in the document or as
 *  the cursor of a code block's CodeMirror editor. */
type Place = Selection | { code: CodeMirror; pos: number };

/** A rendered child of a node, with its document position and its box. */
interface Child {
  node: ProseNode;
  pos: number;
  box: DOMRect;
}

/** `value` kept between `min` and `max`. */
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** The side of the view's text column, inside its padding, that `x` lies
 *  beyond, or null when it lies within the column. */
function sideOf(view: EditorView, x: number): Side | null {
  const { dom } = view;
  const box = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  const left = box.left + dom.clientLeft + parseFloat(style.paddingLeft);
  const right = box.left + dom.clientLeft + dom.clientWidth - parseFloat(style.paddingRight);
  return x < left ? "left" : x > right ? "right" : null;
}

/** The rendered child of `parent`, whose content starts at `start`, whose box
 *  is nearest the point. Height counts first, so the block at the point's
 *  height wins, and then the distance across, so the cell nearer the point
 *  wins in a table row. */
function nearestChild(view: EditorView, parent: ProseNode, start: number, x: number, y: number): Child | null {
  let nearest: (Child & { dx: number; dy: number }) | null = null;
  parent.forEach((node, offset) => {
    const pos = start + offset;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const box = dom.getBoundingClientRect();
    const dy = Math.max(box.top - y, y - box.bottom, 0);
    const dx = Math.max(box.left - x, x - box.right, 0);
    if (!nearest || dy < nearest.dy || (dy === nearest.dy && dx < nearest.dx)) nearest = { node, pos, box, dx, dy };
  });
  return nearest;
}

/** The caret on the line of the text block `child` nearest the height `y`,
 *  at the line's start on the left and at its end on the right, where a
 *  click at the block's edge at that height puts it. */
function lineCaret(view: EditorView, { node, pos, box }: Child, y: number, side: Side): Selection {
  const left = side === "left" ? box.left + 1 : box.right - 1;
  const found = view.posAtCoords({ left, top: clamp(y, box.top + 1, box.bottom - 1) });
  const start = pos + 1;
  const end = pos + node.nodeSize - 1;
  const head = found && found.pos >= start && found.pos <= end ? found.pos : side === "left" ? start : end;
  return TextSelection.create(view.state.doc, head);
}

/** The cursor at the start or end of the line of code nearest the height `y`
 *  in the code block `child`. A block whose code is hidden, as when its preview
 *  shows alone, is selected as a whole instead, as its block handle selects
 *  it. */
function codeCursor(view: EditorView, { pos }: Child, y: number, side: Side): Place {
  const block = view.nodeDOM(pos);
  const editor = block instanceof HTMLElement ? block.querySelector(".cm-editor") : null;
  const code = editor instanceof HTMLElement ? CodeMirror.findFromDOM(editor) : null;
  if (!code?.dom.getClientRects().length) return NodeSelection.create(view.state.doc, pos);
  // Code blocks do not wrap their lines, so a line block is one line.
  const line = code.lineBlockAtHeight(y - code.documentTop);
  return { code, pos: side === "left" ? line.from : line.to };
}

/**
 * Where a press at a point in the view's side padding goes (see the header),
 * or null to leave it to the browser, as beside the lines of a paragraph or a
 * heading. It descends from the document through the block nearest the point
 * at each level, such as a list, its item and the item's paragraph, or a
 * table, its row and a cell, to a text block, a code block or a block that
 * takes no caret.
 */
function placeBeside(view: EditorView, x: number, y: number, side: Side): Place | null {
  let parent: ProseNode = view.state.doc;
  let start = 0;
  for (;;) {
    const child = nearestChild(view, parent, start, x, y);
    if (!child) return null;
    const { node, pos, box } = child;
    if (node.type.spec.code) return codeCursor(view, child, y, side);
    if (node.isTextblock) return parent === view.state.doc && box.top <= y && y <= box.bottom ? null : lineCaret(view, child, y, side);
    if (node.isAtom) return selectedOnClick(node) ? NodeSelection.create(view.state.doc, pos) : null;
    parent = node;
    start = pos + 1;
  }
}

/** Take a press in the view's side padding beside anything but the lines of
 *  a paragraph or heading, and put the caret, the code's cursor or the
 *  selection where it goes (see the header). */
function paddingPress(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0 || event.target !== view.dom) return;
  const side = sideOf(view, event.clientX);
  const place = side && placeBeside(view, event.clientX, event.clientY, side);
  if (!place) return;
  event.preventDefault();
  if ("code" in place) {
    // A code block passes its selection on to the document when it gets
    // focus, so the cursor is set first.
    place.code.dispatch({ selection: { anchor: place.pos }, scrollIntoView: true, userEvent: "select.pointer" });
    place.code.focus();
    return;
  }
  if (!(place instanceof TextSelection)) {
    selectThenFocus(view, place);
    return;
  }
  const focused = view.hasFocus();
  dragSelect(view, event.shiftKey && focused ? view.state.selection.anchor : place.head, place.head);
  // Focusing first would move focus back into a code block that holds the
  // selection, since focusing the view puts the browser's selection there.
  if (!focused) view.focus();
}

/** ProseMirror plugin that takes a press in the document's side padding
 *  beside anything but the lines of a paragraph or heading (see the header).
 *  ProseMirror and its plugins leave a press that a listener cancelled. */
export const paddingPresses = $prose(
  () =>
    new Plugin({
      view(view) {
        const press = (event: MouseEvent): void => paddingPress(view, event);
        view.dom.addEventListener("mousedown", press, true);
        return { destroy: () => view.dom.removeEventListener("mousedown", press, true) };
      },
    }),
);
