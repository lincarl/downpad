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
// CodeMirror handles presses on its text only. A press on a gutter went to
// the browser. On a line number or a fold arrow, Chromium focused CodeMirror's
// scroll container, which takes no keys, so the next key was lost. On a
// Shift+press in the fold gutter's blank space beside a line, it extended the
// selection to the start of the text, and the next key replaced the text in
// between. A press on a line number therefore puts the cursor at the start of
// its line, as a press left of the line's text does, and focuses the editor.
// A Shift+press there while the editor has focus extends the selection to that
// point instead. A press on another gutter, such as on a fold arrow, keeps
// focus and the selection where they were, and CodeMirror still folds or
// unfolds on the click.
//
// In the Markdown view the gutters reach down to the editor's bottom
// (app.css), so a press below the end of the Markdown can land on them. There
// a press on any gutter below the last line puts the cursor at the end of the
// text, as CodeMirror does for a press below the last line in the text beside
// it, and a Shift+press while the editor has focus extends the selection to
// there. CodeMirror's fold gutter takes a click below the last line for one on
// the last line, so a click there unfolded a folded last section. Such a click
// is therefore stopped before it reaches the gutter. In a code block a press
// on a gutter below the last line, beside the code's bottom padding, counts as
// one beside the last line.

import type { Extension } from "@codemirror/state";
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
 *  focus the editor. On a press on another gutter, keep focus and the
 *  selection where they were (see the header). With `endBelowText`, a press
 *  on any gutter below the last line goes to the end of the text instead,
 *  and the click that follows does not reach the gutter. CodeMirror's
 *  handlers see presses on its content only, so this listens on its scroll
 *  container, which holds the gutters. */
function gutterPresses(endBelowText: boolean): Extension {
  return ViewPlugin.define((view) => {
    /** The line at the height of `event` on a gutter, and whether `event`
     *  lies below it, past the last line, where `endBelowText` takes it. */
    const lineAt = (event: MouseEvent) => {
      const height = event.clientY - view.documentTop;
      const line = view.lineBlockAtHeight(height);
      return { line, below: endBelowText && height > line.bottom };
    };
    const press = (event: MouseEvent): void => {
      const { target } = event;
      if (event.button !== 0 || !(target instanceof Element) || !target.closest(".cm-gutters")) return;
      event.preventDefault();
      const { line, below } = lineAt(event);
      if (!below && !target.closest(".cm-lineNumbers")) return;
      const head = below ? view.state.doc.length : line.from;
      const anchor = event.shiftKey && view.hasFocus ? view.state.selection.main.anchor : head;
      // A code block in the document passes its selection on to the document
      // when it gets focus, so the selection is set first.
      view.dispatch({ selection: { anchor, head }, userEvent: "select.pointer" });
      view.focus();
    };
    const click = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest(".cm-gutters") && lineAt(event).below) event.stopPropagation();
    };
    view.scrollDOM.addEventListener("mousedown", press);
    // In the capture phase, before the fold gutter's own listener.
    view.scrollDOM.addEventListener("click", click, true);
    return {
      destroy: () => {
        view.scrollDOM.removeEventListener("mousedown", press);
        view.scrollDOM.removeEventListener("click", click, true);
      },
    };
  });
}

/** CodeMirror extensions for a Shift+press from outside the editor and a
 *  press on a gutter (see the header). `endBelowText` is for the Markdown
 *  view, where a press on a gutter below the last line goes to the end of
 *  the text. */
export function codeMirrorPresses({ endBelowText = false } = {}): Extension {
  return [shiftPressFromOutside, gutterPresses(endBelowText)];
}
