// A press on a list item's bullet or number.
//
// Crepe draws each list item's bullet or number in a label left of the item's
// text, outside the text the user edits. Chromium puts the caret of a click
// on the label where it finds the nearest place for one. For a number, which
// is text, that is the start of the item's text. A bullet is a drawing with no
// such place nearby, so Chromium put the caret at the start of the document,
// often out of view, and the next key went there. While a code block had
// focus, focus stayed in the block, the code's cursor went to its end, and a
// Shift+click selected the code to there, so the next key replaced it. From
// the find card or the Markdown pane a Shift+click focused the document
// without a caret, and the next key was lost. With cells selected,
// prosemirror-tables took the Shift+click, selected one cell and kept focus
// outside.
//
// This plugin takes the press itself, in the capture phase, before
// ProseMirror and prosemirror-tables see it. It puts the caret at the start of
// the item's text and focuses the document, as a click on a number does, and
// a drag from there selects to the pointer. A Shift+press while the document
// has focus extends the selection to the start of the item's text instead.
// From outside the document, a Shift+press is a plain one, as on the
// document's text (shiftClicks.ts). A task item's box toggles the task on the
// press, which Crepe's view handles, and cancels the press, so no mouse
// events follow it.

import { Plugin, Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { dragSelect } from "./shiftClicks";

/** The position at the start of the text of the list item whose bullet or
 *  number `target` is in, or null when it is in none or in a task's box. */
function labelledText(view: EditorView, target: EventTarget | null): number | null {
  const label = target instanceof Element ? target.closest(".label-wrapper") : null;
  if (!label || !view.dom.contains(label)) return null;
  // The label comes before the item's content, so it maps to the content's start.
  const $start = view.state.doc.resolve(view.posAtDOM(label, 0));
  const item = $start.parent;
  if (item.type.name !== "list_item" || item.attrs.checked != null) return null;
  return Selection.findFrom($start, 1, true)?.from ?? null;
}

/** Put the caret at the start of the text of the list item whose bullet or
 *  number is pressed, or extend the selection to there on a Shift+press in
 *  the focused view, and follow the pointer until the button is released
 *  (see the header). */
function labelPress(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0) return;
  const start = labelledText(view, event.target);
  if (start === null) return;
  event.preventDefault();
  const focused = view.hasFocus();
  dragSelect(view, event.shiftKey && focused ? view.state.selection.anchor : start, start);
  // Focusing first would move focus back into a code block that holds the
  // selection, since focusing the view puts the browser's selection there.
  if (!focused) view.focus();
}

/** ProseMirror plugin that takes a press on a list item's bullet or number
 *  (see the header). ProseMirror ignores a press that a listener cancelled. */
export const listLabelClicks = $prose(
  () =>
    new Plugin({
      view(view) {
        const press = (event: MouseEvent): void => labelPress(view, event);
        view.dom.addEventListener("mousedown", press, true);
        return { destroy: () => view.dom.removeEventListener("mousedown", press, true) };
      },
    }),
);
