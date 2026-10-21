// A press in the document's side padding, and one below its end.
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
// the code takes focus. CodeMirror follows a drag only from a press on its
// own text, and Chromium none from a cancelled press, so a drag from there
// selected nothing. The plugin therefore follows it and selects in the code,
// as a drag in the code does, and beside the code to the start or end of the
// line at the pointer's height, until the button is released, the window
// loses focus or Esc is pressed. Beside an image on its own line or a rule,
// which take no caret, the press selects it, as a click on it does. A press
// in the gap between two blocks goes to the nearer one.
//
// A Shift+press while the document has focus extends the selection to the
// line's start or end, as Chromium does beside a paragraph. Beside a code
// block, an image or a rule, and from outside the document, such as from the
// find card, the Markdown pane or a code block, a Shift+press is a plain one,
// as on those blocks themselves (shiftClicks.ts, codeMirrorPresses.ts). So it
// is while a block, such as an image on its own line, or table cells are
// selected. The anchor of such a selection is not in text, and a text
// selection from there starts in the text after it, so the selected image was
// left out, and with a table after the image the selection started in its
// first cell and the next key broke the table up. From selected cells the
// selection started in the cell where the cell selection ended.
//
// A press in the view's bottom padding, below the last block, lands on the
// view's own element too. Chromium put the caret on the last line, at its end
// on Linux and macOS but at the point nearest the press on Windows, and left
// of the text column the side padding rule put it at the line's start. On the
// page below the view, focus stayed where it was (shell/pagePresses.ts). A
// press below the end of the document, in the bottom padding or on the page
// below the view, which pagePresses.ts hands on to the view, therefore puts
// the caret at the end of the document, as most editors do. Crepe keeps an
// empty paragraph after a last block that is not a paragraph or a heading,
// such as a list, a table, a code block or an image, so there is a line to
// type on. The end is then that line, where the next key starts a new
// paragraph and replaces no block. As beside a line, a drag from there
// selects to the pointer, and to the end while the pointer stays below the
// last block (nearestBlock.ts), and a Shift+press extends the selection to the
// end while the document has focus and is a plain one from outside it.

import { EditorSelection } from "@codemirror/state";
import { EditorView as CodeMirror } from "@codemirror/view";
import { NodeSelection, Plugin, Selection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { belowContent } from "../../shell/pagePresses";
import { nearestBlock, textPosition, type Block } from "./nearestBlock";
import { dragSelect, followPointer, selectedOnClick, selectThenFocus } from "./shiftClicks";

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

/** Select in `code` from `anchor` to the pointer while the mouse button is
 *  held (see the header). In the side padding the selection runs to the
 *  start or end of the line at the pointer's height, as for the press, and
 *  elsewhere to where CodeMirror puts it for a drag in the code, which is
 *  the code's start or end above or below the code. As in `dragSelect`, a
 *  change to the code moves the anchor to that of the code's selection. */
function dragInCode(view: EditorView, code: CodeMirror, anchor: number): void {
  let doc = code.state.doc;
  const extend = (left: number, top: number): boolean => {
    if (!view.dom.contains(code.dom)) return false;
    if (code.state.doc !== doc) {
      doc = code.state.doc;
      anchor = code.state.selection.main.anchor;
    }
    const side = sideOf(view, left);
    const head = side ? lineEdge(code, top, side) : code.posAtCoords({ x: left, y: top }, false);
    const next = EditorSelection.single(anchor, head);
    if (!next.eq(code.state.selection)) code.dispatch({ selection: next, userEvent: "select.pointer" });
    return true;
  };
  // Esc collapses the code's selection, which the next move would undo.
  followPointer(view, extend, { endOnEscape: true });
}

/** Take a press in the view's side padding beside anything but the lines of
 *  a paragraph or heading, or one below the last block, put the caret, the
 *  code's cursor or the selection where it goes, and follow a drag from
 *  there (see the header). The last block ends where the view's bottom
 *  padding starts. */
function paddingPress(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0 || event.target !== view.dom) return;
  const { clientX: x, clientY: y } = event;
  const side = sideOf(view, x);
  const place = belowContent(view.dom, y) ? Selection.atEnd(view.state.doc) : side && placeBeside(view, x, y, side);
  if (!place) return;
  event.preventDefault();
  if ("code" in place) {
    // A code block passes its selection on to the document when it gets
    // focus, so the cursor is set first.
    place.code.dispatch({ selection: { anchor: place.pos }, scrollIntoView: true, userEvent: "select.pointer" });
    place.code.focus();
    dragInCode(view, place.code, place.pos);
    return;
  }
  if (!(place instanceof TextSelection)) {
    selectThenFocus(view, place);
    return;
  }
  const focused = view.hasFocus();
  // A text selection from the anchor of a selected block or of selected
  // cells, which is not in text, starts in the text after it (see the header).
  const extend = event.shiftKey && focused && view.state.selection.$anchor.parent.inlineContent;
  dragSelect(view, extend ? view.state.selection.anchor : place.head, place.head);
  // Focusing first would move focus back into a code block that holds the
  // selection, since focusing the view puts the browser's selection there.
  if (!focused) view.focus();
}

/** ProseMirror plugin that takes a press in the document's side padding
 *  beside anything but the lines of a paragraph or heading, and one below
 *  the last block (see the header). ProseMirror and its plugins leave a press
 *  that a listener cancelled. */
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
