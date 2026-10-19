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
// Chromium cannot start a selection right after a line break and before an
// inline atom. It starts the selection before the line break instead, so its
// Shift+End there also selected the line break, and typing replaced the break
// along with the line. The plugin therefore handles Shift+End there itself. It
// finds the end of the line as Chromium's End does from after the atoms and
// selects from the anchor to there. ProseMirror leaves typing over a selection
// in one text block to Chromium, so the plugin types over such a selection
// itself.

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
 *  Shift+End keeps the selection's anchor and leaves out a line break before
 *  the atoms, also when the selection is typed over. */
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
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
          // Leave End to Chromium, which goes on from the new caret.
          if (!event.shiftKey) return false;
          // Move the caret as Chromium's End would, and select from the anchor
          // to where it lands.
          const dom = view.dom.ownerDocument.getSelection();
          if (!dom?.focusNode) return false;
          dom.modify("move", "forward", "lineboundary");
          const lineEnd = view.posAtDOM(dom.focusNode, dom.focusOffset);
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.anchor, lineEnd)));
          return true;
        },
        handleKeyPress: (view, event) => {
          // A selection that starts right after a line break and before an
          // inline atom, which Chromium would type over from before the break.
          const { selection } = view.state;
          const { $from } = selection;
          if (!(selection instanceof TextSelection) || selection.empty || $from.nodeBefore?.type.name !== "hardbreak" || !$from.nodeAfter || !isInlineAtom($from.nodeAfter)) return false;
          // Type as ProseMirror does over a selection it handles itself.
          const text = String.fromCharCode(event.charCode);
          if (/[\r\n]/.test(text)) return false;
          const typed = () => view.state.tr.insertText(text).scrollIntoView();
          if (!view.someProp("handleTextInput", (handle) => handle(view, selection.from, selection.to, text, typed))) view.dispatch(typed());
          return true;
        },
      },
    }),
);
