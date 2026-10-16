// The keyboard shortcuts the Settings dialog lists. Each one is bound in code:
// the app-wide handler (src/app/installAppShortcuts.ts), the tab strip
// (src/App.tsx), the link view (src/editor/wysiwyg/linkView.ts), Tab in the
// document view (src/editor/wysiwyg/tabExit.ts), and the Milkdown keymaps the
// Crepe editor installs (preset-commonmark, preset-gfm, plugin-history;
// CodeMirror's history keymap matches for undo and redo). The frontmatter table
// runs the document's undo and redo for the same keys
// (src/editor/wysiwyg/frontmatterHistory.ts).
// Keep this list in step when a binding changes.

export interface Shortcut {
  action: string;
  /** Alternatives are joined with " / ", in the order the action names them. */
  keys: string;
}

export const KEYBOARD_SHORTCUTS: readonly Shortcut[] = [
  { action: "New document", keys: "Ctrl+N" },
  { action: "Open", keys: "Ctrl+O" },
  { action: "Save / save as", keys: "Ctrl+S / Ctrl+Shift+S" },
  { action: "Print", keys: "Ctrl+P" },
  { action: "Close the focused tab", keys: "Delete" },
  { action: "Find / replace", keys: "Ctrl+F / Ctrl+H" },
  { action: "Find next / previous", keys: "F3 / Shift+F3" },
  { action: "Undo / redo", keys: "Ctrl+Z / Ctrl+Y" },
  { action: "Paste as plain text", keys: "Ctrl+Shift+V" },
  { action: "Bold / italic", keys: "Ctrl+B / Ctrl+I" },
  { action: "Strikethrough", keys: "Ctrl+Alt+X" },
  { action: "Inline code", keys: "Ctrl+E" },
  { action: "Heading 1 to 6", keys: "Ctrl+Alt+1 to Ctrl+Alt+6" },
  { action: "Paragraph", keys: "Ctrl+Alt+0" },
  { action: "Bulleted / numbered list", keys: "Ctrl+Alt+8 / Ctrl+Alt+7" },
  { action: "Indent / outdent list item, next / previous table cell", keys: "Tab / Shift+Tab" },
  { action: "Leave the document", keys: "Esc, then Tab" },
  { action: "Quote", keys: "Ctrl+Shift+B" },
  { action: "Code block", keys: "Ctrl+Alt+C" },
  { action: "Open link", keys: "Ctrl+click" },
];
