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
// selection, which it has ProseMirror do before the next frame is drawn, or
// before text or a composition that comes sooner without a key press.
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
//
// The same handler readies a selection that is not text, such as a selected
// block or selected table cells, for a composition. ProseMirror types a key
// over such a selection itself, and the prosemirror-view patch types text
// that comes without a composition the same way. A composition went to
// Chromium, which cannot put text where a block was. ProseMirror read the
// DOM selection as the composition started, which over an image between two
// paragraphs left the caret at the end of the paragraph above, and the
// composed text went there with the image kept. So the plugin replaces the
// selection as a typed key does, with no text, and the composition goes on
// from the caret that leaves, in an empty paragraph where the block was or
// in the cell where a key's text goes. Chromium places the caret after the
// composition's first text by text offsets it read before the change, so
// the plugin puts that caret right (`caretAfterFirstText`). The change and
// the composition are one undo step, which brings the block or the cells
// back. A composition that commits nothing, as when it is cancelled, is
// taken back once ProseMirror has read its end, in the same task, with the
// undo history and focus as they were before it, so the block or the cells
// are selected as before and no key or other composition comes in between.

import { historyProviderPlugin } from "@milkdown/kit/plugin/history";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection, type EditorState, type Selection, type SelectionBookmark, type Transaction } from "@milkdown/kit/prose/state";
import type { Step } from "@milkdown/kit/prose/transform";
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

/** Whether `selection` is not text but covers something, such as a selected
 *  block, selected table cells or the whole document. A gap cursor covers
 *  nothing. */
function coversNonText(selection: Selection): boolean {
  return !(selection instanceof TextSelection) && !selection.empty;
}

/** A selection that is not text that a composition replaced, until the
 *  composition ends. */
interface Replaced {
  /** The document the composition leaves if it commits nothing. */
  empty: ProseNode;
  /** The steps that take `empty` back to the document before. */
  back: Step[];
  /** The selection before. */
  selection: SelectionBookmark;
  /** The undo history before, from Milkdown's history plugin. */
  history: unknown;
}

/** Replaces a selection that is not text, which a composition is about to
 *  replace, as a typed key does but with no text, and leaves the caret where
 *  the key's text would go. Returns the change and what the composition
 *  replaces. */
function readyForComposition(state: EditorState): { tr: Transaction; replaced: Replaced } {
  // ProseMirror types a key over a selection that is not text with
  // insertText, which wraps the text in a paragraph where a block was and
  // puts the caret after it. Type a space that way and take it out again.
  const tr = state.tr.insertText(" ");
  const end = tr.selection.from;
  tr.delete(end - 1, end);
  const replaced: Replaced = {
    empty: tr.doc,
    back: tr.steps.map((step, index) => step.invert(tr.docs[index]!)).reverse(),
    selection: state.selection.getBookmark(),
    history: historyProviderPlugin.key()?.getState(state),
  };
  return { tr: tr.scrollIntoView(), replaced };
}

/** Takes back the replacement of a selection that is not text, whose
 *  composition committed nothing, with its selection and undo history from
 *  before, and gives focus back to the document view if it had it. */
function putBack(view: EditorView, replaced: Replaced): void {
  const tr = view.state.tr;
  for (const step of replaced.back) tr.step(step);
  tr.setSelection(replaced.selection.resolve(tr.doc)).scrollIntoView();
  // Carry the undo history from before as prosemirror-history's next state,
  // as an undo does with its own. An undo would keep the replacement as a
  // redo step, and redo would replace the content again.
  const key = historyProviderPlugin.key();
  if (key) tr.setMeta(key, { redo: false, historyState: replaced.history });
  const focused = view.hasFocus();
  view.dispatch(tr);
  // Crepe's code block view takes focus in its code when it is selected, so
  // a code block, a math block or a Mermaid diagram took it. Text that IBus
  // commits after the composition then went into the code. Give focus back
  // to the document view, as before the composition, so the block stays
  // selected and the next key or text replaces it.
  if (focused && !view.hasFocus()) view.focus();
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
 *  a composition replaces it. Replaces a selection that is not text as a key
 *  does before a composition, and puts it back if the composition commits
 *  nothing. */
export const endPastAtoms = $prose(() => {
  /** The anchor of the selection that a Shift key is extending from right
   *  after a line break, until ProseMirror reads the extended selection. */
  let keptAnchor: number | null = null;
  /** Has ProseMirror read the selection a Shift key extended, if it has not
   *  yet. Text that comes without a key press, as from an input method or the
   *  emoji panel, can come before the browser reports that selection. */
  const readExtended = (view: EditorView) => {
    if (keptAnchor !== null) view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
  };
  /** Puts the caret after the text of a composition's first step, in the
   *  text block that a selection that is not text gave way to. Chromium puts
   *  that caret at the text offset where the selection started before
   *  compositionstart, plus the length of the text. The change made at
   *  compositionstart moved where the text goes, such as past the break
   *  before a new paragraph or past the text of a cell it emptied, so the
   *  caret landed elsewhere, such as at the end of the paragraph above.
   *  ProseMirror finds the composition's text from the caret, so it drew the
   *  new text again, which ended the composition, and the next step started
   *  another one after it. Text that goes into a text node ProseMirror drew
   *  keeps that node, so only text in a node of its own needs the caret.
   *  Chromium calls observers in the order they were made, and this one is
   *  made before the view and its own observer, so ProseMirror reads the
   *  caret this puts. It stops after the first change it sees. */
  const caretAfterFirstText = new MutationObserver((records) => {
    caretAfterFirstText.disconnect();
    const text = records.flatMap((record) => [...record.addedNodes]).find((node): node is Text => node.nodeType === Node.TEXT_NODE);
    text?.ownerDocument.getSelection()?.collapse(text, text.length);
  });
  return new Plugin({
    view: (view) => {
      /** What the composition that runs replaced, until it ends. */
      let replaced: Replaced | null = null;
      /** Removes a selection that a composition is about to replace, or
       *  replaces one that is not text as a key does. */
      const removeSelection = () => {
        readExtended(view);
        replaced = null;
        caretAfterFirstText.disconnect();
        if (crossesBreakEdge(view.state.selection)) {
          view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
          return;
        }
        // A composition in a field of a node view, such as a code block's
        // code or an image's caption, starts there and leaves the document
        // without focus.
        if (!coversNonText(view.state.selection) || !view.hasFocus()) return;
        // Read a move of the selection that ProseMirror has not read yet, as
        // the prosemirror-view patch does before text without a key, so a
        // composition right after Page Up goes where Page Up put the caret.
        view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
        if (!coversNonText(view.state.selection)) return;
        const replacement = readyForComposition(view.state);
        // Start a new undo step. The composition's first change joins it, as
        // it comes right after this one and next to it, and its later changes
        // join that one, as they carry the same composition id.
        view.dispatch(closeHistory(replacement.tr));
        replaced = replacement.replaced;
        const { node } = view.domAtPos(view.state.selection.head);
        caretAfterFirstText.observe(node, { childList: true, characterData: true, subtree: true });
      };
      /** Takes back the replacement of a selection that is not text when its
       *  composition ends having committed nothing. */
      const putBackIfEmpty = (event: CompositionEvent) => {
        caretAfterFirstText.disconnect();
        const started = replaced;
        replaced = null;
        if (!started || event.data) return;
        // ProseMirror reads the composition's last change by the end of its
        // own compositionend handler, which runs before this one, or in a
        // microtask that it queues there. Run after that, in the same task,
        // so no key, such as Ctrl+Z, and no other composition comes between.
        queueMicrotask(() => {
          if (!view.isDestroyed && view.state.doc.eq(started.empty)) putBack(view, started);
        });
      };
      // Ready the selection in the capture phase, before ProseMirror and
      // Milkdown. Take it back in the bubble phase. ProseMirror listens on its
      // element from when the view is made, before this, so this listener
      // runs after ProseMirror's.
      view.dom.addEventListener("compositionstart", removeSelection, true);
      view.dom.addEventListener("compositionend", putBackIfEmpty);
      return {
        destroy: () => {
          caretAfterFirstText.disconnect();
          view.dom.removeEventListener("compositionstart", removeSelection, true);
          view.dom.removeEventListener("compositionend", putBackIfEmpty);
        },
      };
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
          readExtended(view);
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
