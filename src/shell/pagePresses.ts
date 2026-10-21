// Presses outside the element that has focus (spec §5.6).
//
// Chromium extends the selection of the editor that has focus on a Shift+press
// anywhere in the window, also on an element that takes no caret, such as a
// code block's toolbar, the page beside the document or the empty part of the
// tab strip. From the split's Markdown pane it extended the pane's selection
// toward the press, which CodeMirror cut off at the pane's start or end, and
// focus stayed in the pane, so the next key replaced the Markdown between the
// caret and that point. From the find card it focused the document at its old
// caret. `shiftPressesAsClicks` has the browser take such a press as a plain
// click instead. It leaves a selection in text that cannot be edited, such as
// a read-only value in the frontmatter table, which Chromium extends as on any
// page.
//
// A press on the page around the editors, such as beside the document's
// column or in a split pane's margin, moved focus to the page, so the next key
// went nowhere, also when the document had focus. `pagePressesKeepFocus`
// cancels such a press, so focus and the caret stay where they were. Below the
// end of the document view, in the document's column or the split's document
// pane, focus stayed where it was too. Most editors put the caret at the end
// there, so the press goes on to the document view as a press at the same
// point, which the view takes as one below its last block and puts the caret
// at its end (editor/wysiwyg/paddingPresses.ts). Beside the document's column,
// focus stays where it was at any height, since the page there shows no line
// where the document ends.

/** The editors a press on the page lays out around: the document view and
 *  each CodeMirror editor, such as the Markdown view. */
const EDITORS = ".ProseMirror, .cm-editor";

/** Have the browser take a Shift+press inside `root` as a plain click when
 *  the focused element does not hold what was pressed and the selection is
 *  that of an editor or a text field, as when the Markdown pane has focus and
 *  the press is in the document (see the header). Chromium extends only a
 *  selection there is, so this drops the browser's selection after the
 *  press's handlers, just before the browser handles the press. A press that
 *  a handler cancelled, or during which a handler moved focus, as the
 *  document view does for a press on its text, is left as it is, and so is a
 *  selection in text that cannot be edited. Returns a function that stops
 *  this. */
export function shiftPressesAsClicks(root: HTMLElement): () => void {
  const page = root.ownerDocument;
  let focusedAtPress: Element | null = null;
  const listening = new AbortController();
  const pressed = (): void => {
    focusedAtPress = page.activeElement;
  };
  const handled = (event: MouseEvent): void => {
    if (!event.shiftKey || event.button !== 0 || event.defaultPrevented) return;
    const focused = page.activeElement;
    if (focused !== focusedAtPress) return;
    const selection = page.getSelection();
    if (!selection?.rangeCount || inPlainText(selection.anchorNode)) return;
    if (focused && focused !== page.body && event.target instanceof Node && focused.contains(event.target)) return;
    selection.removeAllRanges();
  };
  root.addEventListener("mousedown", pressed, { capture: true, signal: listening.signal });
  root.addEventListener("mousedown", handled, { signal: listening.signal });
  return () => listening.abort();
}

/** Whether a selection at `node` is in text that cannot be edited. Chromium
 *  reports the selection of a focused text field, such as the find card's, at
 *  the field's place in its parent element, so such a selection is not. */
function inPlainText(node: Node | null): boolean {
  return node instanceof Text && !node.parentElement?.isContentEditable;
}

/** Whether the height `y` lies below the content of `element`, inside its
 *  bottom padding or below it. The document view's content ends with its
 *  last block. */
export function belowContent(element: Element, y: number): boolean {
  const top = element.getBoundingClientRect().top + element.clientTop;
  return y > top + element.clientHeight - (parseFloat(getComputedStyle(element).paddingBottom) || 0);
}

/** A copy of the press `event` at the same point, with the same button, keys
 *  and click count. It does not bubble, so of the listeners around the
 *  element it is sent to, such as this one, only those for the capture phase
 *  see it. */
function pressCopy(event: MouseEvent): MouseEvent {
  const { clientX, clientY, screenX, screenY, button, buttons, detail, altKey, ctrlKey, metaKey, shiftKey, view } = event;
  return new MouseEvent("mousedown", { clientX, clientY, screenX, screenY, button, buttons, detail, altKey, ctrlKey, metaKey, shiftKey, view, cancelable: true });
}

/** Keep focus where it was on a press on the page around the editors in
 *  `area`, and hand a press below the document view's end on to the view
 *  (see the header). Such a press lands outside the editors on an element
 *  that holds one, such as `area` itself, the document's column or a split
 *  pane. Below the content of the document view that the column or pane
 *  shows, the press goes to the view, as a press at the same point. A press
 *  inside an editor, or on another element, such as the
 *  frontmatter table or the split's divider, is left as it is. Returns a
 *  function that stops this. */
export function pagePressesKeepFocus(area: HTMLElement): () => void {
  const press = (event: MouseEvent): void => {
    const { target } = event;
    if (event.button !== 0 || !(target instanceof Element) || target.closest(EDITORS)) return;
    if (!target.querySelector(EDITORS)) return;
    event.preventDefault();
    if (target === area) return;
    const editor = [...target.querySelectorAll(EDITORS)].find((element) => element.getClientRects().length > 0);
    if (editor?.matches(".ProseMirror") && belowContent(editor, event.clientY)) editor.dispatchEvent(pressCopy(event));
  };
  area.addEventListener("mousedown", press);
  return () => area.removeEventListener("mousedown", press);
}
