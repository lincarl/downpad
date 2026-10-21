// Ctrl or Cmd+click, Shift+click and presses on the gutter in a code block.
// Crepe draws each code block with its own CodeMirror editor, and CodeMirror
// adds a cursor on a click with Ctrl, or Cmd on macOS, and keeps the cursors
// it had. A block that does not have focus still has a cursor, at its start
// unless the block had focus before, so a Ctrl or Cmd+click there from outside
// the block left a second cursor the user had not put there, and typing went
// in at both. A Shift+click and a press on the gutter are handled as in the
// Markdown view (codeMirrorPresses.ts).

import { EditorView } from "@codemirror/view";
import { codeMirrorPresses } from "../codeMirrorPresses";

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** CodeMirror extensions for Crepe's code blocks. A Ctrl or Cmd+click adds a
 *  cursor only in a block that already has focus, and anywhere else puts the
 *  one cursor at the click, as a plain click does. A Shift+click in a block
 *  that does not have focus puts the cursor at the click too, and a press on
 *  a line number puts it at the start of the line. */
export const codeBlockClicks = [
  EditorView.clickAddsSelectionRange.of((event: MouseEvent): boolean => {
    if (!(mac ? event.metaKey : event.ctrlKey)) return false;
    const editor = event.target instanceof Element ? event.target.closest(".cm-editor") : null;
    return editor instanceof HTMLElement && !!EditorView.findFromDOM(editor)?.hasFocus;
  }),
  codeMirrorPresses(),
];
