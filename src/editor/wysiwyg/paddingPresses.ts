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
// and of its last cell on the right. A drag from there selects to the text
// under the pointer, or beside the text to the line at the pointer's height,
// which it finds as the press does (nearestBlock.ts), so a press that moves a
// pixel or two stays a caret. Beside a code block, a math block or a Mermaid
// diagram, the cursor goes to the start or end of the line of code at that
// height, or of the nearest line beside the block's toolbar or preview, and
// the code takes focus. Beside an image on its own line or a rule, which
// take no caret, the press selects it, as a click on it does. A press in the
// gap between two blocks goes to the nearer one.
//
// A Shift+press while the document has focus extends the selection to the
// line's start or end, as Chromium does beside a paragraph. Beside a code
// block, an image or a rule, and from outside the document, such as from the
// find card, the Markdown pane or a code block, a Shift+press is a plain one,
// as on those blocks themselves (shiftClicks.ts, codeMirrorPresses.ts).

import { EditorView as CodeMirror } from "@codemirror/view";
import { NodeSelection, Plugin, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { nearestBlock, textPosition, type Block } from "./nearestBlock";
import { dragSelect, selectedOnClick, selectThenFocus } from "./shiftClicks";

/** The side of the document's text column that a press is on. */
type Side = "left" | "right";

/** Where a press beside a block goes, as a selection in the document or as
 *  the cursor of a code block's CodeMirror editor. */
type Place = Selection | { code: CodeMirror; pos: number };

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

/** The start or end of the line of code nearest the height `y` in `code`.
 *  Code blocks do not wrap their lines, so a line block is one line, and
 *  CodeMirror gives the first or last line for a height above or below the
 *  code, as beside the block's toolbar or preview. */
function lineEdge(code: CodeMirror, y: number, side: Side): number {
  const line = code.lineBlockAtHeight(y - code.documentTop);
  return side === "left" ? line.from : line.to;
}

/** The cursor at the start or end of the line of code nearest the height `y`
 *  in the code block `block`. A block whose code is hidden, as when its
 *  preview shows alone, is selected as a whole instead, as its block handle
 *  selects it. */
function codeCursor(view: EditorView, { pos }: Block, y: number, side: Side): Place {
  const dom = view.nodeDOM(pos);
  const editor = dom instanceof HTMLElement ? dom.querySelector(".cm-editor") : null;
  const code = editor instanceof HTMLElement ? CodeMirror.findFromDOM(editor) : null;
  if (!code?.dom.getClientRects().length) return NodeSelection.create(view.state.doc, pos);
  return { code, pos: lineEdge(code, y, side) };
}

/**
 * Where a press at a point in the view's side padding goes (see the header),
 * or null to leave it to the browser, as beside the lines of a paragraph or a
 * heading. The block beside the point is the text block, code block or block
 * that takes no caret nearest it (`nearestBlock`).
 */
function placeBeside(view: EditorView, x: number, y: number, side: Side): Place | null {
  const block = nearestBlock(view, x, y);
  if (!block) return null;
  const { node, pos, box, topLevel } = block;
  if (node.type.spec.code) return codeCursor(view, block, y, side);
  if (node.isTextblock) return topLevel && box.top <= y && y <= box.bottom ? null : TextSelection.create(view.state.doc, textPosition(view, block, x, y));
  return selectedOnClick(node) ? NodeSelection.create(view.state.doc, pos) : null;
}

/** Take a press in the view's side padding beside anything but the lines of
 *  a paragraph or heading, put the caret, the code's cursor or the selection
 *  where it goes, and follow a drag from there (see the header). */
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
