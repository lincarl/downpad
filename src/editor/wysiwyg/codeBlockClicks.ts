// Ctrl or Cmd+click and Shift+click in a code block. Crepe draws each code
// block with its own CodeMirror editor, and CodeMirror adds a cursor on a
// click with Ctrl, or Cmd on macOS, and keeps the cursors it had. A block that
// does not have focus still has a cursor, at its start unless the block had
// focus before, so a Ctrl or Cmd+click there from outside the block left a
// second cursor the user had not put there, and typing went in at both.
//
// A Shift+click selects from that cursor to the click. From outside the
// block, such as from the document's text, the Markdown pane or another code
// block, the cursor is not one the user sees, so the next key replaced the
// code from the block's start, or from where its cursor last was, to the
// click. A Shift+press in a block that does not have focus therefore first
// puts the cursor at the press, so CodeMirror's selection from there ends at
// the click, as a plain click's caret does, and a Shift+drag from there
// selects from the press.

import { EditorView } from "@codemirror/view";

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** CodeMirror extensions for Crepe's code blocks. A Ctrl or Cmd+click adds a
 *  cursor only in a block that already has focus, and anywhere else puts the
 *  one cursor at the click, as a plain click does. A Shift+click in a block
 *  that does not have focus puts the cursor at the click too. */
export const codeBlockClicks = [
  EditorView.clickAddsSelectionRange.of((event: MouseEvent): boolean => {
    if (!(mac ? event.metaKey : event.ctrlKey)) return false;
    const editor = event.target instanceof Element ? event.target.closest(".cm-editor") : null;
    return editor instanceof HTMLElement && !!EditorView.findFromDOM(editor)?.hasFocus;
  }),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.shiftKey || event.button !== 0 || view.hasFocus) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) view.dispatch({ selection: { anchor: pos } });
      // CodeMirror's own handling then selects from there to the press.
      return false;
    },
  }),
];
