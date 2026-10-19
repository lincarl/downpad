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
// Chromium cannot keep the anchor of a selection right after a line break and
// before an inline atom. Each time Shift with End, an arrow key or another key
// that moves the caret extends such a selection, Chromium moves the anchor
// before the line break. So Shift+End there selected the line break too, the
// first time or the next, and typing replaced the break along with the line.
// The plugin puts the anchor back when ProseMirror reads the extended
// selection, which it has ProseMirror do before the next frame is drawn.
// ProseMirror leaves typing over a selection in one text block to Chromium,
// whose own selection starts or ends before the break instead. Its typing
// replaced the break with a selection that started there and kept it with one
// that ended there, so the plugin types over such selections itself. It takes
// the text from the beforeinput event, which carries all of it, so the same
// holds for a character outside the Basic Multilingual Plane, such as an
// emoji, and for text an input method or the emoji panel inserts without
// composing.
//
// An input method's composition replaces Chromium's own selection too, and
// it cannot be cancelled. Over a selection that started after the break, a
// composition removed the break and its text came in twice, and over one
// that ended there it kept the break. So when a composition starts over such
// a selection, the plugin first removes the selection with ProseMirror, and
// the composition goes on from the caret that leaves. It does that before
// ProseMirror and Milkdown handle the start of the composition. Milkdown
// types a composition itself when the caret sits between two inline nodes,
// such as a line break and a formula, but only if the caret is there when
// the composition starts, so a selection removed later made the text come
// in twice.

import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Whether End moves the caret. On macOS it scrolls the page instead, and
 *  Cmd+Right goes to the end of the line. */
const END_MOVES_CARET = typeof navigator === "undefined" || !/Mac/.test(navigator.platform);

/** Keys that move the caret, and with Shift extend the selection. */
const MOVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Whether `node` is an inline node without text the caret can enter, such as
 *  an image, a formula, a footnote reference or inline HTML. A line break ends
 *  the line instead. */
function isInlineAtom(node: ProseNode): boolean {
  return node.isInline && node.isAtom && !node.isText && node.type.name !== "hardbreak";
}

/** Whether `$pos` is right after a line break and before an inline atom, where
 *  Chromium cannot keep a selection's anchor. */
function afterBreakBeforeAtom($pos: ResolvedPos): boolean {
  return $pos.nodeBefore?.type.name === "hardbreak" && !!$pos.nodeAfter && isInlineAtom($pos.nodeAfter);
}

/** Whether `selection` starts or ends right after a line break and before an
 *  inline atom, where Chromium's own selection starts or ends before the break
 *  instead. */
function crossesBreakEdge(selection: Selection): boolean {
  return selection instanceof TextSelection && !selection.empty && (afterBreakBeforeAtom(selection.$from) || afterBreakBeforeAtom(selection.$to));
}

/** Moves the caret past the inline atoms that start its line, keeping the
 *  selection's anchor when `extend` is set. */
function moveEndPastAtoms(view: EditorView, extend: boolean): void {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection)) return;
  const { $head } = selection;
  // A line starts at the start of a text block or after a line break.
  if ($head.parentOffset > 0 && $head.nodeBefore?.type.name !== "hardbreak") return;
  let end = $head.pos;
  for (let index = $head.index(); index < $head.parent.childCount; index++) {
    const child = $head.parent.child(index);
    if (!isInlineAtom(child)) break;
    end += child.nodeSize;
  }
  if (end === $head.pos) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, extend ? selection.anchor : end, end)));
}

/** Moves the caret past the inline atoms that start its line when End or
 *  Shift+End is pressed there, so the key reaches the end of the line. Keeps
 *  the anchor of a selection that Shift and a key that moves the caret extend
 *  from right after a line break and before an inline atom, types over a
 *  selection that starts or ends there, and removes such a selection before
 *  a composition replaces it. */
export const endPastAtoms = $prose(() => {
  /** The anchor of the selection that a Shift key is extending from right
   *  after a line break, until ProseMirror reads the extended selection. */
  let keptAnchor: number | null = null;
  return new Plugin({
    view: (view) => {
      /** Removes a selection that a composition is about to replace. */
      const removeSelection = () => {
        if (crossesBreakEdge(view.state.selection)) view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
      };
      // Listen in the capture phase, before ProseMirror and Milkdown.
      view.dom.addEventListener("compositionstart", removeSelection, true);
      return { destroy: () => view.dom.removeEventListener("compositionstart", removeSelection, true) };
    },
    props: {
      handleKeyDown: (view, event) => {
        if (event.isComposing) return false;
        const end = END_MOVES_CARET && event.key === "End" && !event.ctrlKey && !event.metaKey && !event.altKey;
        // ProseMirror reads the caret a key such as Home moved, and the
        // selection the last key extended, when the browser reports the
        // change. A key pressed right after can come first, so have
        // ProseMirror read it now.
        if (end || keptAnchor !== null) view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
        keptAnchor = null;
        if (end) moveEndPastAtoms(view, event.shiftKey);
        // Leave the key to Chromium, which goes on from the new caret, and
        // keep the anchor of the selection it extends.
        const { selection } = view.state;
        if (event.shiftKey && MOVING_KEYS.has(event.key) && selection instanceof TextSelection && afterBreakBeforeAtom(selection.$anchor)) {
          keptAnchor = selection.anchor;
          // Have ProseMirror read the extended selection before Chromium
          // draws it, so the line break never shows as selected.
          requestAnimationFrame(() => {
            if (keptAnchor !== null) view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
            keptAnchor = null;
          });
        }
        return false;
      },
      handleDOMEvents: {
        beforeinput: (view, event) => {
          const text = event.data;
          if (event.isComposing || event.inputType !== "insertText" || !text || /[\r\n]/.test(text)) return false;
          const { selection } = view.state;
          if (!crossesBreakEdge(selection)) return false;
          event.preventDefault();
          // Type as ProseMirror does over a selection it handles itself.
          const typed = () => view.state.tr.insertText(text).scrollIntoView();
          if (!view.someProp("handleTextInput", (handle) => handle(view, selection.from, selection.to, text, typed))) view.dispatch(typed());
          return true;
        },
      },
    },
    appendTransaction: (transactions, _oldState, state) => {
      if (keptAnchor === null || !transactions.some((transaction) => transaction.selectionSet || transaction.docChanged)) return null;
      const anchor = keptAnchor;
      keptAnchor = null;
      // The first change after the key is the selection Chromium extended,
      // unless it is an edit or a click.
      const { selection } = state;
      if (transactions.some((transaction) => transaction.docChanged || transaction.getMeta("pointer")) || !(selection instanceof TextSelection) || selection.anchor !== anchor - 1) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, anchor, selection.head));
    },
  });
});
