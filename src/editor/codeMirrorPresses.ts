// Presses in a CodeMirror editor, for the document's code blocks and the
// Markdown view (spec §5.6).
//
// CodeMirror selects from its cursor to a Shift+click. An editor that does not
// have focus still has a cursor, at its start unless the editor had focus
// before, and the user does not see it. So a Shift+click from the document's
// text, the Markdown pane or another code block into a code block, or from the
// document into the split's Markdown pane, selected from that cursor to the
// click, and the next key replaced the code or Markdown in between. A
// Shift+press in an editor that does not have focus therefore first puts the
// cursor at the press, so CodeMirror's selection from there ends at the click,
// as a plain click's caret does, and a Shift+drag from there selects from the
// press.
//
// CodeMirror handles presses on its text only. A press on a line number went
// to the browser, which focused CodeMirror's scroll container. That takes no
// keys, so the next key was lost. A press on a line number therefore puts the
// cursor at the start of its line, as a press left of the line's text does,
// and focuses the editor. A Shift+press there while the editor has focus
// extends the selection to that point instead. A press on a fold arrow, in the
// gutter beside the line numbers, is left to CodeMirror, which folds or
// unfolds on the click and leaves the selection as it is.

import { EditorView, ViewPlugin } from "@codemirror/view";

/** Put the cursor at a Shift+press in an editor that does not have focus,
 *  before CodeMirror's own handling selects from the cursor to the press. */
const shiftPressFromOutside = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!event.shiftKey || event.button !== 0 || view.hasFocus) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) view.dispatch({ selection: { anchor: pos } });
    return false;
  },
});

/** Put the cursor at the start of the line of a pressed line number, or
 *  extend the selection to there on a Shift+press in the focused editor, and
 *  focus the editor (see the header). CodeMirror's handlers see presses on
 *  its content only, so this listens on its scroll container, which holds
 *  the gutters. */
const lineNumberPresses = ViewPlugin.define((view) => {
  const press = (event: MouseEvent): void => {
    const { target } = event;
    if (event.button !== 0 || !(target instanceof Element) || !target.closest(".cm-lineNumbers")) return;
    event.preventDefault();
    const { from } = view.lineBlockAtHeight(event.clientY - view.documentTop);
    const anchor = event.shiftKey && view.hasFocus ? view.state.selection.main.anchor : from;
    // A code block in the document passes its selection on to the document
    // when it gets focus, so the selection is set first.
    view.dispatch({ selection: { anchor, head: from }, userEvent: "select.pointer" });
    view.focus();
  };
  view.scrollDOM.addEventListener("mousedown", press);
  return { destroy: () => view.scrollDOM.removeEventListener("mousedown", press) };
});

/** CodeMirror extensions for a Shift+press from outside the editor and a
 *  press on a line number (see the header). */
export const codeMirrorPresses = [shiftPressFromOutside, lineNumberPresses];
