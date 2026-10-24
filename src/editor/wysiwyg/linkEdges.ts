// Text put in at either end of a link starts plain text outside the link
// (spec §5.6). Milkdown's link mark is inclusive, as ProseMirror marks are by
// default, so ProseMirror gave text typed at a link's end, or at the start of
// a block that begins with a link, the link. Downpad keeps the mark
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
// marks across the selection. Typing there keeps the caret on the link's
// side while it stays in its text block, and so does deleting the link's own
// text with Backspace or Delete. A move of the caret ends it. So does
// deleting the text on the other side of the caret, or the link's whole
// text, which leave no link in the marks the caret's next text gets, so the
// tail shows the plain side again.
//
// Stored marks stay in the state while the caret rests at a link's edge.
// ProseMirror would give them to text that the browser changes elsewhere,
// so that text gets the marks of its own place (`handleTextInput` below), and
// find and replace clears them (autolinkReplace.ts). Other code that puts
// text in away from the caret with `insertText` or `replaceSelectionWith`
// must clear them too.
//
// ProseMirror also gives plain text that is dropped the marks of the place it
// is dropped on, and the drop then puts it in a block of its own at a block
// edge (dropEdge.ts). So text dropped on a link became a new link to the same
// target.
// `transformPasted` below takes the link off.
//
// A file dropped right before a link to the same target, such as a missing
// attachment that the file now fills, joins that link, so the caret after the
// file is inside one link. fileDrop.ts makes that caret a plain caret
// (`keepCaretPlain`). It follows the caret while each change maps it to
// where the caret is, as typing, Backspace, Delete, undo and Milkdown's
// update of a heading's id do, and a plain caret inside a link gets the
// marks there without the link, as a caret at a link's edge does. Stored
// marks alone did not last, as ProseMirror drops them on every change, and
// after Backspace or Delete gives the caret's next text the deleted text's
// marks.

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

/** What the plugin tracks. */
interface LinkEdgesState {
  /** The caret position on a link's side, where typing goes into the link,
   *  or null. */
  side: number | null;
  /** The caret position right after a dropped file, where typing stays out
   *  of a link even inside it, or null. */
  plain: number | null;
}

const linkEdgesKey = new PluginKey<LinkEdgesState>("downpad-link-edges");

/** Make the caret at `pos` after `tr` a plain caret, where text put in stays
 *  out of a link around it while the caret stays there, as right after a
 *  dropped file whose link joins the same link after it. */
export function keepCaretPlain(tr: Transaction, pos: number): Transaction {
  return tr.setMeta(linkEdgesKey, pos);
}

/** The marks that text put in at the caret of `state` gets, without a link
 *  the caret is not inside, or at a plain caret without any link, or null
 *  when they hold no such link. */
function plainMarksAt(state: EditorState): readonly Mark[] | null {
  const $cursor = caretOf(state);
  if (!$cursor) return null;
  const marks = state.storedMarks ?? $cursor.marks();
  const plain = linkEdgesKey.getState(state)?.plain === $cursor.pos;
  const link = plain ? state.schema.marks.link?.isInSet(marks) : edgeLink($cursor, marks);
  return link ? link.removeFromSet(marks) : null;
}

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
 * caret there, and so does typing over selected link text. Typing there, or
 * a change elsewhere, keeps it there while the caret stays in its text block
 * and the marks for the caret's next text still hold a link beside it, as
 * after Backspace or Delete takes some of the link's own text. A move of the
 * caret or other stored marks end it, and so does deleting the text on the
 * other side of the caret or the link's whole text.
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

/** The plain caret after `tr`, given `plain` before it. `keepCaretPlain`
 *  puts it at a position, and it follows the caret while the caret stays at
 *  that position as `tr` maps it, as typing, Backspace, Delete and undo
 *  leave it there. */
function plainCaret(tr: Transaction, plain: number | null, after: EditorState): number | null {
  if (plain === null) return null;
  const mapped = tr.mapping.map(plain);
  return caretOf(after)?.pos === mapped ? mapped : null;
}

/** The state after `tr`. A plain caret placed by `tr` ends a link side, and
 *  a link side ends a plain caret, so the last of them wins. */
function applyLinkEdges(tr: Transaction, value: LinkEdgesState, before: EditorState, after: EditorState): LinkEdgesState {
  const placed = tr.getMeta(linkEdgesKey) as number | undefined;
  if (placed !== undefined) return { side: null, plain: placed };
  const side = linkSide(tr, value.side, before, after);
  return { side, plain: side === null ? plainCaret(tr, value.plain, after) : null };
}

/** Whether the caret of `state` is on a link's side at its edge, where
 *  typing goes into the link. */
function onLinkSide(state: EditorState): boolean {
  const side = linkEdgesKey.getState(state)?.side ?? null;
  return side !== null && side === caretOf(state)?.pos;
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
 *  every change, a caret at a link's edge, or a plain caret inside a link,
 *  gets the marks there without the link as its stored marks, unless it is
 *  on the link's side (`linkSide`). */
function linkEdgesPlugin(): Plugin<LinkEdgesState> {
  return new Plugin<LinkEdgesState>({
    key: linkEdgesKey,
    state: {
      init: () => ({ side: null, plain: null }),
      apply: applyLinkEdges,
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
       *  even though the drop puts the text in a block of its own at a block
       *  edge, outside that link. A paste at the caret gets the marks there
       *  again from Milkdown's paste handling, which reads stored marks. */
      transformPasted(slice, view, plain) {
        const link = view.state.schema.marks.link;
        return plain && link ? new Slice(withoutLinks(slice.content, link), slice.openStart, slice.openEnd) : slice;
      },
    },
    appendTransaction(_transactions, _before, state) {
      if (onLinkSide(state)) return null;
      const marks = plainMarksAt(state);
      return marks ? state.tr.setStoredMarks(marks) : null;
    },
  });
}

/** `linkEdgesPlugin` for `editor.use`. */
export const linkEdges = $prose(() => linkEdgesPlugin());
