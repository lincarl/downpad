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
// click instead.
//
// A press on the page around the editors, such as beside the document's
// column, in a split pane's margin or below the end of the document view or
// the Markdown view, moved focus to the page, so the next key went nowhere,
// also when the document had focus.
// `pagePressesKeepFocus` cancels such a press, so focus and the caret stay
// where they were.

/** The editors a press on the page lays out around: the document view and
 *  each CodeMirror editor, such as the Markdown view. */
const EDITORS = ".ProseMirror, .cm-editor";

/** Have the browser take a Shift+press inside `root` as a plain click when
 *  the focused element does not hold what was pressed, as when the Markdown
 *  pane has focus and the press is in the document (see the header).
 *  Chromium extends only a selection there is, so this drops the browser's
 *  selection after the press's handlers, just before the browser handles the
 *  press. A press that a handler cancelled, or during which a handler moved
 *  focus, as the document view does for a press on its text, is left as it
 *  is. Returns a function that stops this. */
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
    if (focused && focused !== page.body && event.target instanceof Node && focused.contains(event.target)) return;
    page.getSelection()?.removeAllRanges();
  };
  root.addEventListener("mousedown", pressed, { capture: true, signal: listening.signal });
  root.addEventListener("mousedown", handled, { signal: listening.signal });
  return () => listening.abort();
}

/** Keep focus where it was on a press on the page around the editors in
 *  `area` (see the header). Such a press lands outside the editors on an
 *  element that holds one, such as `area` itself, the document's column or a
 *  split pane. A press inside an editor, or on another element, such as the
 *  frontmatter table or the split's divider, is left as it is. Returns a
 *  function that stops this. */
export function pagePressesKeepFocus(area: HTMLElement): () => void {
  const press = (event: MouseEvent): void => {
    const { target } = event;
    if (event.button !== 0 || !(target instanceof Element) || target.closest(EDITORS)) return;
    if (target.querySelector(EDITORS)) event.preventDefault();
  };
  area.addEventListener("mousedown", press);
  return () => area.removeEventListener("mousedown", press);
}
