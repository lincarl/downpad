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
// block, selected table cells or a selected image or formula in a line, for
// a composition. ProseMirror types a key over such a selection itself, and
// the prosemirror-view patch types text that comes without a composition the
// same way. A composition went to Chromium, which cannot put text where a
// block was. ProseMirror read the DOM selection as the composition started,
// which over an image between two paragraphs left the caret at the end of
// the paragraph above, and the composed text went there with the image kept.
// So the plugin replaces a selected block or selected cells as a typed key
// does, with no text, and the composition goes on from the caret that
// leaves, in an empty paragraph where the block was or in the cell where a
// key's text goes. Chromium places the caret after the composition's first
// text by text offsets it read before the change, so the plugin puts that
// caret right (`caretAfterFirstText`). Chromium replaces a selected image in
// a line itself, which stays selected for ProseMirror too (`keepNode`), and a
// formula gives way to a selected space with its marks, which the
// composition types over (`readyForComposition`). The change and
// the composition are one undo step, which brings the selection's content
// back. A composition that commits nothing, as when it is cancelled, is
// taken back once ProseMirror has read its end, in the same task, with the
// undo history and focus as they were before it, so the content is selected
// as before and no key or other composition comes in between.

import { historyProviderPlugin } from "@milkdown/kit/plugin/history";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, TextSelection, type Selection, type SelectionBookmark, type Transaction } from "@milkdown/kit/prose/state";
import type { Step } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { putBackWaitingMarks, waitingMarks } from "./mathDelimiters";

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

/** Whether `a` and `b` hold the same nodes, text, marks and attributes, apart
 *  from the ids of headings. Milkdown gives each heading an id from its text,
 *  numbers the id of a heading whose text an earlier heading has, and keeps
 *  the ids in sync as the document changes. So a change to one heading can
 *  rename another one. Any other change counts, such as an image's new file
 *  that an edit started before the composition put in meanwhile. */
function sameContent(a: ProseNode, b: ProseNode): boolean {
  if (a === b) return true;
  const attrs = a.type.name === "heading" ? { ...b.attrs, id: a.attrs.id } : b.attrs;
  if (!a.hasMarkup(b.type, attrs, b.marks) || a.text !== b.text || a.childCount !== b.childCount) return false;
  for (let index = 0; index < a.childCount; index++) {
    if (!sameContent(a.child(index), b.child(index))) return false;
  }
  return true;
}

/** A selection that is not text that a composition replaced, until the
 *  composition ends. */
interface Replaced {
  /** The document the composition leaves if it commits nothing, apart from
   *  the ids of headings (`sameContent`). */
  empty: ProseNode;
  /** The steps that take `empty` back to the document before. */
  back: Step[];
  /** The selection before. */
  selection: SelectionBookmark;
  /** The undo history before, from Milkdown's history plugin. */
  history: unknown;
  /** The typed closing marks that waited before, and those that undo and
   *  redo make wait again, which follow the undo history. */
  waiting: ReturnType<typeof waitingMarks>;
}

/** Readies a selection that is not text for a composition that is about to
 *  replace it as a typed key does, and returns the change to make and what
 *  the composition replaces.
 *
 *  A selected block, selected cells or the whole document give way to the
 *  caret where the key's text would go, such as in an empty paragraph where
 *  a block was. A node in a line whose element holds no text, such as an
 *  image, stays selected, with no change, and Chromium replaces it as it
 *  replaces selected text. ProseMirror reads that as typing over the node,
 *  which gives the text the node's marks, such as a link, as a key's text
 *  gets them. Chromium cannot replace an element that holds text, such as a
 *  formula's, so such a node gives way to a selected space with its marks,
 *  and the composition types over that. Replacing a node in a line with the
 *  caret lost its marks, and between two images Milkdown's widgets beside
 *  the caret made ProseMirror draw the first step's text again, which ended
 *  the composition, so the text came in twice. A selected space at the end
 *  of a link's text does that too. Chromium types a step that adds to the
 *  text of the step before, as Japanese input does, after the link's
 *  element, as it does over selected text there, and ProseMirror draws that
 *  text inside the link. Over an image the later steps stay in the link, so
 *  an image does not use a space, and a formula at the end of a link's text
 *  gets its first step's text twice, as selected text there does. */
function readyForComposition(view: EditorView): { tr: Transaction; replaced: Replaced } {
  const { state } = view;
  const { selection } = state;
  const inline = selection instanceof NodeSelection && selection.node.isInline;
  const native = inline && !view.nodeDOM(selection.from)?.textContent;
  // ProseMirror types a key over a selection that is not text with
  // insertText, which wraps the text in a paragraph where a block was, gives
  // it the marks of a node in a line, and puts the caret after it.
  const typed = () => state.tr.insertText(" ");
  const emptied = native ? state.tr.deleteSelection() : typed();
  const end = emptied.selection.from;
  if (!native) emptied.delete(end - 1, end);
  const replaced: Replaced = {
    empty: emptied.doc,
    back: emptied.steps.map((step, index) => step.invert(emptied.docs[index]!)).reverse(),
    selection: selection.getBookmark(),
    history: historyProviderPlugin.key()?.getState(state),
    waiting: waitingMarks(state),
  };
  if (native) return { tr: state.tr, replaced };
  if (!inline) return { tr: emptied.scrollIntoView(), replaced };
  const tr = typed();
  return { tr: tr.setSelection(TextSelection.create(tr.doc, end - 1, end)).scrollIntoView(), replaced };
}

/** Takes back the replacement of a selection that is not text, whose
 *  composition committed nothing, with its selection and undo history from
 *  before, and gives focus back to where it was. `tr` starts from the
 *  document the composition left, `replaced.empty` apart from headings'
 *  ids. */
function putBack(view: EditorView, replaced: Replaced, tr: Transaction): void {
  for (const step of replaced.back) tr.step(step);
  tr.setSelection(replaced.selection.resolve(tr.doc)).scrollIntoView();
  // Carry the undo history from before as prosemirror-history's next state,
  // as an undo does with its own. An undo would keep the replacement as a
  // redo step, and redo would replace the content again.
  const key = historyProviderPlugin.key();
  if (key) tr.setMeta(key, { redo: false, historyState: replaced.history });
  // The math delimiters' guard keeps a record for each undo and redo step,
  // which the replacement cut back, and took this change for an undo, so
  // redo put back a formula as plain text.
  putBackWaitingMarks(tr, replaced.waiting);
  const { activeElement } = view.dom.ownerDocument;
  const focused = view.hasFocus();
  view.dispatch(tr);
  // Start a new undo step, as after an undo, so the next edit does not join
  // the edit before the composition.
  view.dispatch(closeHistory(view.state.tr));
  // Crepe's code block view takes focus in its code when it is selected, so
  // a code block, a math block or a Mermaid diagram took it. Text that IBus
  // commits after the composition then went into the code. Give focus back
  // to where it was, the document view, where the next key or text replaces
  // the block, or another field.
  if (view.dom.ownerDocument.activeElement === activeElement) return;
  if (focused) view.focus();
  else if (activeElement instanceof HTMLElement && activeElement !== view.dom.ownerDocument.body) activeElement.focus({ preventScroll: true });
  else if (view.dom.ownerDocument.activeElement instanceof HTMLElement) view.dom.ownerDocument.activeElement.blur();
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
  /** Whether a composition starts over a selected node in a line that stays
   *  selected, such as an image, until ProseMirror has started it. */
  let keepNode = false;
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
        keepNode = false;
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
        const replacement = readyForComposition(view);
        // Start a new undo step, with this change if it makes one. The
        // composition's first change joins it, as it comes right after this
        // one and next to it, and its later changes join that one, as they
        // carry the same composition id.
        view.dispatch(closeHistory(replacement.tr));
        replaced = replacement.replaced;
        // ProseMirror reads the browser's range around an image that stays
        // selected as it starts the composition. It took that range for
        // selected text, which the undo step kept, so an undo selected text
        // instead of the image, and a composition cancelled after it removed
        // the image. Have it read the image's selection instead.
        keepNode = view.state.selection instanceof NodeSelection;
        // Text typed over a selection in a line goes where the selection
        // started, so only a caret that took a block's place needs this.
        if (!view.state.selection.empty) return;
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
        // Milkdown can rename a heading right after the change that readied
        // the selection, and again as the composition ends, so the ids of
        // headings need not match (`sameContent`). The same nodes and text
        // have the same positions, so the steps back still apply, and Milkdown
        // renames the headings again after them. Any other change made
        // meanwhile keeps the replacement, and its undo step.
        queueMicrotask(() => {
          if (view.isDestroyed) return;
          // A composition that ends before Chromium typed over the selected
          // space that took a formula's place leaves that space.
          const tr = view.state.tr;
          if (!sameContent(tr.doc, started.empty)) tr.deleteSelection();
          if (sameContent(tr.doc, started.empty)) putBack(view, started, tr);
        });
      };
      /** Stops keeping a node selected once ProseMirror has started the
       *  composition. */
      const startedComposition = () => {
        keepNode = false;
      };
      // Ready the selection in the capture phase, before ProseMirror and
      // Milkdown. Stop keeping a node selected, and take the selection back,
      // in the bubble phase. ProseMirror listens on its element from when the
      // view is made, before this, so the bubble-phase listeners run after
      // ProseMirror's.
      view.dom.addEventListener("compositionstart", removeSelection, true);
      view.dom.addEventListener("compositionstart", startedComposition);
      view.dom.addEventListener("compositionend", putBackIfEmpty);
      return {
        destroy: () => {
          caretAfterFirstText.disconnect();
          view.dom.removeEventListener("compositionstart", removeSelection, true);
          view.dom.removeEventListener("compositionstart", startedComposition);
          view.dom.removeEventListener("compositionend", putBackIfEmpty);
        },
      };
    },
    props: {
      /** Reads the browser's range around a selected node in a line, such as
       *  an image, as that node's selection while ProseMirror starts a
       *  composition over it (`keepNode`). */
      createSelectionBetween: (view, $anchor, $head) => {
        const { selection } = view.state;
        const covers = selection.from === Math.min($anchor.pos, $head.pos) && selection.to === Math.max($anchor.pos, $head.pos);
        return keepNode && selection instanceof NodeSelection && covers ? selection : null;
      },
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
