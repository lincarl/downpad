// Focus follows the document's selection out of a code block.
//
// Crepe draws each code block with a CodeMirror editor of its own. While one
// has focus, the document view's selection is inside that block, and focusing
// the document view puts the browser's selection where the view's selection
// is, so focus goes back into the block. ProseMirror focuses the view before
// it selects what a click selects, and so does Crepe's block handle before its
// + button puts in a paragraph. So a click from a code block on an image on
// its own line selected the image, and the + button put the caret in a new
// paragraph and opened the block menu there, while focus stayed in the code
// block. The next key went into the code. Once the document's selection has
// left the code block that has focus, this plugin focuses the document view,
// so focus goes where the selection is.

import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** The code block whose CodeMirror editor has focus, or null. */
function focusedCodeBlock(view: EditorView): Element | null {
  const active = view.dom.ownerDocument.activeElement;
  if (!active || active === view.dom || !view.dom.contains(active)) return null;
  return active.closest(".cm-editor")?.closest(".milkdown-code-block") ?? null;
}

/** Focus the view when its selection is outside the code block that has
 *  focus (see the header). */
function followSelection(view: EditorView): void {
  const block = focusedCodeBlock(view);
  if (!block) return;
  // The block's view has no content element, so its element maps to the
  // start of its code.
  const $code = view.state.doc.resolve(view.posAtDOM(block, 0));
  if ($code.depth === 0) return;
  const { from, to } = view.state.selection;
  if (from >= $code.before() && to <= $code.after()) return;
  view.focus();
}

/** ProseMirror plugin that moves focus out of a code block once the
 *  document's selection has left it (see the header). */
export const codeBlockFocus = $prose(
  () =>
    new Plugin({
      view: () => ({
        update(view, previous) {
          if (!view.state.selection.eq(previous.selection)) followSelection(view);
        },
      }),
    }),
);
