// Shift+click and Shift+drag in the document view (spec §5.5, §5.6).
//
// ProseMirror leaves a Shift+click to the browser, and Chromium extends the
// selection to it on most text. It does not when the press lands on a link or
// an image, even in an editable element. On a link it put the caret at the
// click, and a Shift+drag from there started a new selection at the press. On
// an image it left the caret where it was, and a Shift+drag moved the image.
// This plugin handles a Shift+press on link text or on an image in a line
// itself. It selects from the selection's anchor to the position under the
// pointer, or to the side of the image pressed, and follows the pointer until
// the button is released, scrolling the document as Chromium's own drag
// selection does.
//
// While the document view does not have focus, such as when a code block, the
// Markdown pane or the find card has it, the selection to extend is not the
// one the user sees. Chromium extended the selection of the code block or the
// Markdown pane toward the click, which CodeMirror cut off at its start or
// end, and focus stayed there, so the next key replaced the code or Markdown
// between the caret and that point. On an image Chromium placed no caret, and
// the next key went into the editor that had focus. prosemirror-tables, which
// handles a press before the plugins md-easy adds, decided from that
// selection too. A caret left in one cell made a Shift+click into another
// select both cells, and a cell selection made a Shift+click anywhere in the
// document select a cell. It cancelled the press, so focus stayed outside and
// the next key went in there. A Shift+press from outside on the document's
// text or on an inline node such as an image therefore puts the caret at the
// press, or at the side of the node pressed, and focuses the document, before
// any other plugin sees the press. The press then goes on as one in the
// focused document, so a Shift+drag from there selects from the press, and
// selects cells across a table, as a plain drag does.
//
// The press goes on to Chromium, which extends the selection from that caret
// to the point where a plain click puts the caret. The two have to be the
// same, or the next key replaces the text between them. For a press beside or
// below a block's text, such as in a table cell's padding, ProseMirror gives
// the position before or after the block, while Chromium puts the caret in
// the nearest text. The first caret after the end of a cell is in the next
// cell, so prosemirror-tables selected the cells from there to the one
// pressed, and the next key replaced their text. Left of a cell's text and
// below its last line, the caret went to the start of the line, and Chromium
// on Linux and macOS extended the selection to its end. For a press between
// blocks the caret therefore goes where Chromium puts the caret of a plain
// click, as ProseMirror reads it.
//
// With focus in the document, prosemirror-tables selects cells on a
// Shift+click into another cell, or while cells are selected.

import { SchemaReady, prosePluginsCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { isImageNode } from "./imageView";

/** The position a Shift+press at `event` selects to, or null to leave the
 *  press to the browser. A press on an inline node such as an image or a
 *  missing image's chip gives the side of the node's box pressed. With focus
 *  in the document, only a press on link text or an image is taken, since
 *  Chromium extends the selection on other text itself. Without focus, a
 *  press on any of the document's text or inline nodes is taken, but not one
 *  on another element, such as a list item's bullet or an image on its own
 *  line. */
function pressedPosition(view: EditorView, event: MouseEvent, focused: boolean): number | null {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return null;
  const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!found) return null;
  const node = found.inside >= 0 ? view.state.doc.nodeAt(found.inside) : null;
  if (node?.isInline) {
    if (focused && !isImageNode(node)) return null;
    const dom = view.nodeDOM(found.inside);
    if (!(dom instanceof HTMLElement)) return null;
    const { left, width } = dom.getBoundingClientRect();
    return event.clientX < left + width / 2 ? found.inside : found.inside + node.nodeSize;
  }
  if (!target.isContentEditable) return null;
  if (focused && !target.closest("a")) return null;
  return found.pos;
}

/** Put the caret at a Shift+press from outside the document view, or where
 *  a plain click puts it for a press between blocks, and focus the view (see
 *  the header). It returns false, so the press goes on to the other plugins,
 *  ProseMirror and the browser as one in the focused view with the caret at
 *  the press. Focusing first would move focus back into a code block that
 *  holds the selection, since focusing the view puts the browser's selection
 *  where ProseMirror's is. */
function shiftPressFromOutside(view: EditorView, event: MouseEvent): boolean {
  if (!event.shiftKey || event.button !== 0 || view.hasFocus()) return false;
  const pressed = pressedPosition(view, event, false);
  if (pressed === null) return false;
  const { doc } = view.state;
  const head = doc.resolve(pressed).parent.inlineContent ? pressed : clickCaret(view, event) ?? pressed;
  const $head = doc.resolve(head);
  view.dispatch(view.state.tr.setSelection(TextSelection.between($head, $head)).setMeta("pointer", true));
  view.focus();
  return false;
}

/** The position of the caret that Chromium puts at a plain click at
 *  `event`, read as ProseMirror reads the caret of a click, or null when it
 *  is outside the document view. */
function clickCaret(view: EditorView, event: MouseEvent): number | null {
  const caret = view.dom.ownerDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (!caret || !view.dom.contains(caret.offsetNode)) return null;
  return view.posAtDOM(caret.offsetNode, caret.offset, 1);
}

/** Extend the selection on a Shift+press on link text or on an image in a
 *  line while the document view has focus (see the header), from the
 *  selection's anchor to the press. */
function shiftPress(view: EditorView, event: MouseEvent): boolean {
  if (!event.shiftKey || event.button !== 0 || !view.hasFocus()) return false;
  const head = pressedPosition(view, event, true);
  if (head === null) return false;
  event.preventDefault();
  dragSelect(view, view.state.selection.anchor, head);
  return true;
}

/** The nearest ancestor of `element` that scrolls its content vertically. */
function scrollerOf(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Select from `anchor` to `head`, and then to the position under the
 *  pointer until the mouse button is released, as Chromium's own drag
 *  selection follows the pointer. While the pointer is above or below the
 *  document's scroll container, the container scrolls each frame by as far
 *  as the pointer is outside it, as Chromium scrolls, and the selection
 *  follows to the container's edge. Following stops once the selection is no
 *  longer a text selection, as when prosemirror-tables takes the drag over
 *  to select the cells it crosses, and when the window loses focus.
 *
 *  The anchor stays where the press found it, also when another plugin
 *  changes the selection in between. prosemirror-tables makes a selection
 *  that ends at the start of a cell select the paragraph it starts in, and
 *  an anchor taken from that selection stayed at the paragraph's start for
 *  the rest of the drag. A change to the document moves positions, though.
 *  It can be a key pressed while the button is down, such as Backspace, or
 *  a change made along with the selection, such as strikethrough made of
 *  text typed just before. The anchor then becomes that of the selection,
 *  which ProseMirror moved along with the change, as Chromium's drag
 *  selection goes on from where such a key left the caret. */
function dragSelect(view: EditorView, anchor: number, head: number): void {
  let doc = view.state.doc;
  const extend = (to: number): void => {
    const { state } = view;
    if (state.doc !== doc) {
      doc = state.doc;
      anchor = state.selection.anchor;
    }
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(to));
    if (!next.eq(state.selection)) view.dispatch(state.tr.setSelection(next).setMeta("pointer", true));
  };
  extend(head);
  const root = view.dom.ownerDocument;
  const win = root.defaultView;
  const scroller = scrollerOf(view.dom);
  let pointer: { left: number; top: number } | null = null;
  let frame = 0;
  const follow = (): void => {
    frame = 0;
    if (!pointer || view.isDestroyed || !(view.state.selection instanceof TextSelection)) return end();
    const dom = view.dom.getBoundingClientRect();
    let { left, top } = pointer;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const outside = top < box.top ? top - box.top : top > box.bottom ? top - box.bottom : 0;
      if (outside) {
        scroller.scrollTop += outside;
        top = Math.min(Math.max(top, box.top + 1), box.bottom - 1);
        frame = win?.requestAnimationFrame(follow) ?? 0;
      }
    }
    // A point outside the document has no position in it.
    left = Math.min(Math.max(left, dom.left + 1), dom.right - 1);
    top = Math.min(Math.max(top, dom.top + 1), dom.bottom - 1);
    const at = view.posAtCoords({ left, top });
    if (at) extend(at.pos);
  };
  const move = (moved: MouseEvent): void => {
    if (!(moved.buttons & 1)) return end();
    pointer = { left: moved.clientX, top: moved.clientY };
    if (!frame) follow();
  };
  const end = (): void => {
    if (frame) win?.cancelAnimationFrame(frame);
    frame = 0;
    root.removeEventListener("mousemove", move);
    root.removeEventListener("mouseup", end);
    win?.removeEventListener("blur", end);
  };
  root.addEventListener("mousemove", move);
  root.addEventListener("mouseup", end);
  win?.addEventListener("blur", end);
}

/** Milkdown plugin that puts a ProseMirror plugin for a Shift+press from
 *  outside the document view before all others, including prosemirror-tables,
 *  which Crepe adds before any plugin md-easy uses. */
const fromOutside: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const plugin = new Plugin({ props: { handleDOMEvents: { mousedown: shiftPressFromOutside } } });
  ctx.update(prosePluginsCtx, (plugins) => [plugin, ...plugins]);
  return () => ctx.update(prosePluginsCtx, (plugins) => plugins.filter((other) => other !== plugin));
};

/** Milkdown plugins for Shift+click and Shift+drag in the document view (see
 *  the header). The one for a press in the focused view follows
 *  prosemirror-tables, so that one selects cells first. */
export const shiftClicks: MilkdownPlugin[] = [
  fromOutside,
  $prose(() => new Plugin({ props: { handleDOMEvents: { mousedown: shiftPress } } })),
];
