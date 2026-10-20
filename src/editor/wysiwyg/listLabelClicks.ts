// A press on a list item's bullet, number or task box.
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
// document's text (shiftClicks.ts).
//
// A task item's box toggles the task on the press, which Crepe's view handles
// and cancels, so no mouse events follow it. Crepe focuses the document first
// and leaves its selection as it was. While the document has focus, that is
// the selection the user sees, and it stays. From outside the document the
// user does not see it. The next key replaced text selected there, possibly
// out of view, and from a code block focus went back into the block, where
// the next key replaced the selected code. On a press on a task's box
// from outside the document, this plugin therefore first puts the caret at
// the start of the task's text and focuses the document, and Crepe then
// toggles the task.

import { Plugin, Selection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { dragSelect } from "./shiftClicks";

/** The list item whose label `target` is in: the position at the start of its
 *  text, and whether it is a task, or null when `target` is in no label. */
function labelledItem(view: EditorView, target: EventTarget | null): { start: number; task: boolean } | null {
  const label = target instanceof Element ? target.closest(".label-wrapper") : null;
  if (!label || !view.dom.contains(label)) return null;
  // The label comes before the item's content, so it maps to the content's start.
  const $start = view.state.doc.resolve(view.posAtDOM(label, 0));
  const item = $start.parent;
  if (item.type.name !== "list_item") return null;
  const start = Selection.findFrom($start, 1, true)?.from;
  return start === undefined ? null : { start, task: item.attrs.checked != null };
}

/** Put the caret at the start of the text of the list item whose bullet or
 *  number is pressed, or extend the selection to there on a Shift+press in
 *  the focused view, and follow the pointer until the button is released
 *  (see the header). */
function labelPress(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0) return;
  const item = labelledItem(view, event.target);
  if (!item || item.task) return;
  event.preventDefault();
  const focused = view.hasFocus();
  dragSelect(view, event.shiftKey && focused ? view.state.selection.anchor : item.start, item.start);
  // Focusing first would move focus back into a code block that holds the
  // selection, since focusing the view puts the browser's selection there.
  if (!focused) view.focus();
}

/** Put the caret at the start of a task's text and focus the view on a
 *  press on the task's box from outside the view, before Crepe toggles the
 *  task (see the header). */
function taskPress(view: EditorView, event: PointerEvent): void {
  if (event.button !== 0 || view.hasFocus()) return;
  const item = labelledItem(view, event.target);
  if (!item?.task) return;
  const $start = view.state.doc.resolve(item.start);
  view.dispatch(view.state.tr.setSelection(TextSelection.between($start, $start)).setMeta("pointer", true));
  view.focus();
}

/** ProseMirror plugin that takes a press on a list item's bullet or number,
 *  and one on a task's box from outside the document (see the header).
 *  ProseMirror ignores a press that a listener cancelled. */
export const listLabelClicks = $prose(
  () =>
    new Plugin({
      view(view) {
        const press = (event: MouseEvent): void => labelPress(view, event);
        const pointerPress = (event: PointerEvent): void => taskPress(view, event);
        view.dom.addEventListener("mousedown", press, true);
        view.dom.addEventListener("pointerdown", pointerPress, true);
        return {
          destroy: () => {
            view.dom.removeEventListener("mousedown", press, true);
            view.dom.removeEventListener("pointerdown", pointerPress, true);
          },
        };
      },
    }),
);
