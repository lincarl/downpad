// Spell check toggle (spec §5.14). We don't ship a dictionary — this just flips
// the `spellcheck` attribute on the editor's editable elements so WebView2's
// built-in checker (red squiggles + right-click suggestions) turns on/off.
//
// The attribute is inheritable, so setting it on the editor host covers both the
// WYSIWYG (ProseMirror) and raw (CodeMirror) editables. Crepe's code blocks are
// CodeMirror instances (already not spell-checked); inline-code exclusion is a
// later refinement.

const EDITABLE_SELECTORS = '.ProseMirror, .cm-content, [contenteditable="true"]';

/** Apply the spell-check setting to every editable element under `root`. */
export function applySpellcheck(root: HTMLElement, enabled: boolean): void {
  const value = String(enabled);
  root.setAttribute("spellcheck", value);
  root.querySelectorAll(EDITABLE_SELECTORS).forEach((el) => el.setAttribute("spellcheck", value));
}
