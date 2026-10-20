// Text put in at either end of a link starts plain text outside the link
// (spec §5.6). Milkdown's link mark is inclusive, as ProseMirror marks are by
// default, so ProseMirror gave text typed at a link's end, or at the start of
// a block that begins with a link, the link. md-easy keeps the mark
// inclusive. Typing over selected link text needs that to keep the link, and
// Crepe's virtual cursor handles marks that are not inclusive poorly.
//
// Instead, after every change, a caret at a link's edge gets the marks there
// without the link as its stored marks. ProseMirror reads stored marks first
// for text put in at the caret, such as typed text, an input method's
// composition, a paste of plain text or a command's insert. The virtual
// cursor draws its tail from them too, so the tail shows the plain side.
// Deleting a link's whole text stores the link for the caret left where it
// was, inside the text around it, and the caret gets the marks there instead.
//
// Two cases keep typing in the link, on the link's side (`linkSide`). The
// virtual cursor's Left at a link's end where text follows, and its Right at
// a link's start where text comes before, set the link as stored marks
// without moving the caret, and draw the tail on the link's side. And typing
// over selected link text keeps the link, as ProseMirror gives typed text the
// marks across the selection. Typing or deleting there keeps the caret on the
// link's side while it stays in its text block. A move of the caret ends it,
// and so does deleting the link's whole text, so text typed where the link
// was is plain, as after any deletion of a link's whole text.
//
// Stored marks stay in the state while the caret rests at a link's edge.
// ProseMirror would give them to text that the browser changes elsewhere,
// so that text gets the marks of its own place (`handleTextInput` below), and
// find and replace clears them (autolinkReplace.ts). Other code that puts
// text in away from the caret with `insertText` or `replaceSelectionWith`
// must clear them too.
//
// ProseMirror also gives plain text that is dropped the marks of the place it
// is dropped on, and Crepe's drop indicator then puts it in a block of its
// own. So text dropped on a link became a new link to the same target.
// `transformPasted` below takes the link off.

import { Fragment, Mark, Slice, type MarkType, type Node as ProseNode, type ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** The link in `marks` that `$pos` is not inside, so text put in there would
 *  join it from one side or start it anew, or null. A link on both sides of
 *  `$pos` is one the position is inside. Such a link starts or ends at
 *  `$pos`, or is no longer there at all, as after its whole text was deleted. */
function edgeLink($pos: ResolvedPos, marks: readonly Mark[]): Mark | null {
  const link = $pos.doc.type.schema.marks.link?.isInSet(marks);
  if (!link) return null;
  const { nodeBefore, nodeAfter } = $pos;
  const inside = !!nodeBefore && !!nodeAfter && !!link.isInSet(nodeBefore.marks) && !!link.isInSet(nodeAfter.marks);
  return inside ? null : link;
}

/** Whether the link in `marks` is on either side of `$pos`. After a link's
 *  whole text was deleted, the marks stored for the caret still hold it, but
 *  neither side does. */
function linkBeside($pos: ResolvedPos, marks: readonly Mark[]): boolean {
  const link = $pos.doc.type.schema.marks.link?.isInSet(marks);
  const { nodeBefore, nodeAfter } = $pos;
  return !!link && [nodeBefore, nodeAfter].some((node) => !!node && !!link.isInSet(node.marks));
}

/** The caret of `state`, or null for a selection that is not a text caret. */
function caretOf(state: EditorState): ResolvedPos | null {
  const { selection } = state;
  return selection instanceof TextSelection ? selection.$cursor : null;
}

/** The marks that text put in at the caret of `state` gets, without a link
 *  the caret is not inside, or null when they hold no such link. */
function plainMarksAt(state: EditorState): readonly Mark[] | null {
  const $cursor = caretOf(state);
  if (!$cursor) return null;
  const marks = state.storedMarks ?? $cursor.marks();
  const link = edgeLink($cursor, marks);
  return link ? link.removeFromSet(marks) : null;
}

/** The caret position on a link's side, where typing goes into the link, or
 *  null. */
const linkSideKey = new PluginKey<number | null>("md-easy-link-side");

/** Whether `tr` typed over the selection of `before`, which held a link, with
 *  text that kept the link and ends at `$caret`, the link's edge. */
function typedOverLink(tr: Transaction, before: EditorState, $caret: ResolvedPos): boolean {
  const { from, to, empty } = before.selection;
  const link = edgeLink($caret, $caret.marks());
  return !empty && !!link && before.doc.rangeHasMark(from, to, link) && tr.mapping.map(from, -1) < $caret.pos;
}

/**
 * The caret position on a link's side after `tr`, given `side` before it.
 * Stored marks with a link set at the link's edge without moving the caret,
 * as by the virtual cursor's Left at its end or Right at its start, put the
 * caret there, and so does typing over selected link text. Typing or
 * deleting there, or a change elsewhere, keeps it there while the caret stays
 * in its text block and the link is still beside it. A move of the caret,
 * other stored marks, or deleting the link's whole text end it.
 */
function linkSide(tr: Transaction, side: number | null, before: EditorState, after: EditorState): number | null {
  const $caret = caretOf(after);
  if (!$caret) return null;
  if (tr.docChanged) {
    if (typedOverLink(tr, before, $caret)) return $caret.pos;
    const sameBlock = tr.mapping.map(before.selection.$head.start()) === $caret.start();
    const kept = side !== null && tr.mapping.map(side) === $caret.pos && sameBlock;
    return kept && linkBeside($caret, after.storedMarks ?? $caret.marks()) ? $caret.pos : null;
  }
  if (tr.selectionSet) return null;
  if (!tr.storedMarksSet) return side;
  return after.storedMarks && edgeLink($caret, after.storedMarks) ? $caret.pos : null;
}

/** The caret position when the caret is on a link's side at its edge, where
 *  typing goes into the link, or null. */
function linkSideCaret(state: EditorState): number | null {
  const side = linkSideKey.getState(state) ?? null;
  return side !== null && side === caretOf(state)?.pos ? side : null;
}

/** `fragment` with no `link` marks, at any depth. */
function withoutLinks(fragment: Fragment, link: MarkType): Fragment {
  const nodes: ProseNode[] = [];
  fragment.forEach((node) => {
    const inner = node.isLeaf ? node : node.copy(withoutLinks(node.content, link));
    nodes.push(inner.mark(link.removeFromSet(inner.marks)));
  });
  return Fragment.from(nodes);
}

/** A plugin that keeps text put in at a link's edge out of the link. After
 *  every change, a caret at a link's edge gets the marks there without the
 *  link as its stored marks, unless it is on the link's side (`linkSide`). */
function linkEdgesPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: linkSideKey,
    state: {
      init: () => null,
      apply: linkSide,
    },
    props: {
      /** Give text the browser changes away from the caret, such as a text
       *  suggestion or a spelling fix, the marks of its own place. The
       *  stored marks are for text put in at the caret. An input method's
       *  text is left as ProseMirror puts it in, since a change to it while
       *  the composition runs can restart the composition. */
      handleTextInput(view, from, to, text, deflt) {
        const { state } = view;
        const $cursor = caretOf(state);
        if (view.composing || !state.storedMarks || !$cursor || (from === $cursor.pos && to === $cursor.pos)) return false;
        const $from = state.doc.resolve(from);
        const marks = from === to ? $from.marks() : ($from.marksAcross(state.doc.resolve(to)) ?? Mark.none);
        const tr = deflt();
        const end = from + text.length;
        tr.removeMark(from, end);
        for (const mark of marks) tr.addMark(from, end, mark);
        view.dispatch(tr);
        return true;
      },
      /** Take the links off text pasted or dropped as plain text. Plain text
       *  holds no links of its own. ProseMirror gives it the marks of the
       *  place it goes in, which for a drop is the place under the pointer,
       *  even though Crepe's drop indicator puts the text in a block of its
       *  own, outside that link. A paste at the caret gets the marks there
       *  again from Milkdown's paste handling, which reads stored marks. */
      transformPasted(slice, view, plain) {
        const link = view.state.schema.marks.link;
        return plain && link ? new Slice(withoutLinks(slice.content, link), slice.openStart, slice.openEnd) : slice;
      },
    },
    appendTransaction(_transactions, _before, state) {
      if (linkSideCaret(state) !== null) return null;
      const marks = plainMarksAt(state);
      return marks ? state.tr.setStoredMarks(marks) : null;
    },
  });
}

/** `linkEdgesPlugin` for `editor.use`. */
export const linkEdges = $prose(() => linkEdgesPlugin());
