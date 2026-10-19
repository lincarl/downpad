// End in the document view with the caret before an inline atom, such as an
// image or a formula, that starts a line. Chromium does not take the caret from
// there to the end of the line. End and Shift+End left it before the image or
// formula at the start of a paragraph, a list item, a heading or a table cell,
// and End after a line break took it to the end of the next paragraph or of
// the document. This held for working images, missing images' chips, formulas
// and several of them in a row. Before Chromium handles the key, this plugin
// moves the caret past the inline atoms at the start of the line, and
// Chromium's End goes on from the text after them.
//
// Chromium extends a selection that starts right after a line break and before
// an image or a formula back over the line break, as Shift+ArrowRight there
// shows, so Shift+End there also selects the line break.

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** Whether End moves the caret. On macOS it scrolls the page instead, and
 *  Cmd+Right goes to the end of the line. */
const END_MOVES_CARET = typeof navigator === "undefined" || !/Mac/.test(navigator.platform);

/** Whether `node` is an inline node without text the caret can enter, such as
 *  an image, a formula, a footnote reference or inline HTML. A line break ends
 *  the line instead. */
function isInlineAtom(node: ProseNode): boolean {
  return node.isInline && node.isAtom && !node.isText && node.type.name !== "hardbreak";
}

/** Moves the caret past the inline atoms that start its line when End or
 *  Shift+End is pressed there, so the key reaches the end of the line.
 *  Shift+End keeps the selection's anchor. */
export const endPastAtoms = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (!END_MOVES_CARET || event.key !== "End" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
          // ProseMirror reads the caret a key such as Home moved when the
          // browser reports the move. A key pressed right after can come first,
          // so have ProseMirror read it now.
          view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
          const { selection } = view.state;
          if (!(selection instanceof TextSelection)) return false;
          const { $head } = selection;
          // A line starts at the start of a text block or after a line break.
          if ($head.parentOffset > 0 && $head.nodeBefore?.type.name !== "hardbreak") return false;
          let end = $head.pos;
          for (let index = $head.index(); index < $head.parent.childCount; index++) {
            const child = $head.parent.child(index);
            if (!isInlineAtom(child)) break;
            end += child.nodeSize;
          }
          if (end === $head.pos) return false;
          const anchor = event.shiftKey ? selection.anchor : end;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, end)));
          // Leave the key to Chromium, which goes on from the new caret.
          return false;
        },
      },
    }),
);
