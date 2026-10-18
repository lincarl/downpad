// Where a file dropped on the document goes in (§5.4). While something is
// dragged over the document, Crepe's drop indicator (prosemirror-drop-indicator)
// draws a line at the block edge nearest the pointer, and Crepe inserts dropped
// blocks there. md-easy takes file drops before Crepe sees them, so it finds
// that edge the same way and inserts the file's Markdown there itself.

import { editorViewCtx, parserCtx, remarkCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { GapCursor } from "@milkdown/kit/prose/gapcursor";
import { Slice, type Fragment, type Node, type ResolvedPos } from "@milkdown/kit/prose/model";
import { Selection, TextSelection, type EditorState, type Transaction, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Transform, dropPoint } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";
import { differingRuns } from "../differingRuns";

/** Where the files of a drop on the document go in. The editor that made it
 *  keeps the position in step with later edits. */
export interface DropTarget {
  pos: number;
  /** Set once a file of the drop went in as a list item of its own, so the
   *  files after it go in as list items too. */
  listItems?: boolean;
  /** Set for a drop on a Markdown pane whose files go in as paragraphs of
   *  their own at `pos`, the end of a line, as for one on base64 data that is
   *  not a Markdown image's URL. */
  newBlock?: boolean;
}

/**
 * Where a file dropped at a viewport point goes in, as a document position.
 * Over the document that is the block edge Crepe's drop indicator marks there.
 * The indicator does not show above or below the document, so a drop there
 * goes in at its start or end. Null when no block is rendered.
 */
export function dropPosition(view: Pick<EditorView, "dom" | "state" | "nodeDOM">, x: number, y: number): number | null {
  const { top, bottom } = view.dom.getBoundingClientRect();
  if (y < top) return 0;
  if (y > bottom) return view.state.doc.content.size;
  return nearestBlockEdge(view, x, y);
}

/**
 * The block edge nearest a viewport point, as Crepe's drop indicator picks it:
 * the top or bottom edge of any block, lists and their items included, by the
 * distance from the point to the nearer end of the edge. On a tie the earlier
 * position wins. Returns the document position at that edge, or null when no
 * block is rendered.
 */
function nearestBlockEdge(view: Pick<EditorView, "state" | "nodeDOM">, x: number, y: number): number | null {
  const nearest = { pos: -1, distance: Infinity };
  const consider = (pos: number, left: number, right: number, edge: number): void => {
    const distance = Math.min(Math.abs(x - left), Math.abs(x - right)) + Math.abs(y - edge);
    if (distance < nearest.distance || (distance === nearest.distance && pos < nearest.pos)) {
      Object.assign(nearest, { pos, distance });
    }
  };
  view.state.doc.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const { top, bottom, left, right } = dom.getBoundingClientRect();
      consider(pos, left, right, top);
      consider(pos + node.nodeSize, left, right, bottom);
    }
    // A text block's children are inline, so only containers are searched.
    return !node.isTextblock;
  });
  return nearest.pos < 0 ? null : nearest.pos;
}

/** Whether a node is an empty paragraph, a line with nothing typed on it. */
function isEmptyParagraph(node: Node | null | undefined): node is Node {
  return node?.type.name === "paragraph" && node.content.size === 0;
}

const LISTS = new Set(["bullet_list", "ordered_list"]);

/** Whether a node is a bulleted or numbered list. */
function isList(node: Node | null | undefined): boolean {
  return !!node && LISTS.has(node.type.name);
}

/** Whether a position is inside a table, which holds only rows and cells. */
function inTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole) return true;
  }
  return false;
}

/**
 * The list item a drop in a list makes of `content`, and where it goes, or
 * null where the content goes in as it is. Crepe puts a block dropped beside an
 * item's text in that item, and one dropped between the items of a nested
 * list in the parent item, and either way Markdown writes the list loose. So
 * there the content becomes an item of its own, before or after the item, or
 * at the near end of a nested list beside the text. Between the items of a
 * list that is not inside another, Crepe splits the list and the content goes
 * between the two halves, which stay tight, so that is left to it, unless an
 * earlier file of the drop became an item. An image cannot start a list item,
 * so it always goes in as Crepe puts it.
 */
function listItemAt($pos: ResolvedPos, content: Fragment, listItems: boolean): { pos: number; item: Node } | null {
  const { parent, depth } = $pos;
  let pos: number;
  let list: Node;
  if (isList(parent)) {
    if (!listItems && $pos.node(depth - 1).type.name !== "list_item") return null;
    pos = $pos.pos;
    list = parent;
  } else if (parent.type.name === "list_item") {
    const { nodeBefore, nodeAfter } = $pos;
    if (nodeAfter && isList(nodeAfter)) {
      pos = $pos.pos + 1;
      list = nodeAfter;
    } else if (nodeBefore && isList(nodeBefore)) {
      pos = $pos.pos - 1;
      list = nodeBefore;
    } else {
      pos = $pos.index() === 0 ? $pos.before() : $pos.after();
      list = $pos.node(depth - 1);
    }
  } else {
    return null;
  }
  // Every list holds at least one item, the model for the new one. Its number
  // or bullet follows from the list, and it is tight, as typed items are.
  const sibling = list.firstChild;
  if (!sibling?.type.validContent(content)) return null;
  const item = sibling.type.create({ label: sibling.attrs.label, listType: sibling.attrs.listType, spread: false }, content);
  return { pos, item };
}

/**
 * Put `doc`'s blocks in at a drop target, where Crepe puts a block dropped at
 * that edge. They go in beside the blocks there, never splitting one. A table
 * cannot hold them, so a drop on a table puts them above or below it. An empty
 * line at the edge takes them, as typing on it would, so Crepe's empty last
 * line never ends up mid-document, where it would be saved as `<br />`. In a
 * list, a link becomes a list item of its own where Crepe would make the list
 * loose (`listItemAt`). Returns whether the document changed.
 */
function placeBlocks(tr: Transaction, target: DropTarget, doc: Node): boolean {
  const { content } = doc;
  const slice = new Slice(content, 0, 0);
  let pos = target.pos;
  if (inTable(tr.doc.resolve(pos))) pos = dropPoint(tr.doc, pos, slice) ?? pos;
  const $pos = tr.doc.resolve(pos);
  const { parent, nodeBefore, nodeAfter } = $pos;
  const index = $pos.index();
  const listItem = listItemAt($pos, content, target.listItems === true);
  if (isEmptyParagraph(nodeAfter) && parent.canReplace(index, index + 1, content)) {
    tr.replaceWith(pos, pos + nodeAfter.nodeSize, content);
  } else if (isEmptyParagraph(nodeBefore) && parent.canReplace(index - 1, index, content)) {
    tr.replaceWith(pos - nodeBefore.nodeSize, pos, content);
  } else if (listItem) {
    tr.insert(listItem.pos, listItem.item);
    target.listItems = true;
  } else if (content.childCount === 1 && content.firstChild) {
    tr.replaceRangeWith(pos, pos, content.firstChild);
  } else {
    tr.replaceRange(pos, pos, slice);
  }
  return tr.docChanged;
}

/** Where the last step of a transaction ends its change, in the new document. */
function changeEnd(tr: Transaction): number {
  let end = 0;
  tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  return end;
}

/** The end of the text of a file just dropped, while the caret stays there. */
const droppedTextEnd = new PluginKey<number | null>("md-easy-dropped-text-end");

/**
 * A plugin that keeps text typed right after a dropped link out of the link
 * (§5.4). A link takes in text typed at its end. Stored marks cannot stop
 * that for long, because Crepe's list views update a list's items right
 * after a link goes in as an item, which clears them. So while the caret
 * stays at the end of a dropped file's text, typed text goes in without the
 * link.
 */
export function droppedLinkTyping(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: droppedTextEnd,
    state: {
      init: () => null,
      apply(tr, end, _before, state) {
        const placed = tr.getMeta(droppedTextEnd) as number | undefined;
        if (placed !== undefined) return placed;
        if (end === null) return null;
        // Follow the caret while it types on from there.
        const mapped = tr.mapping.map(end);
        return state.selection.empty && state.selection.head === mapped ? mapped : null;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view;
        const link = state.schema.marks.link;
        if (from !== to || droppedTextEnd.getState(state) !== from || !link) return false;
        const marks = state.storedMarks ?? state.doc.resolve(from).marks();
        if (!marks.some((mark) => mark.type === link)) return false;
        const plain = state.schema.text(text, marks.filter((mark) => mark.type !== link));
        view.dispatch(state.tr.replaceWith(from, to, plain).scrollIntoView());
        return true;
      },
    },
  });
}

/**
 * Put a text caret after content just inserted, which ends at `end`, so typing
 * goes on after it. Inserted text keeps the caret right after it, where
 * typing stays out of a dropped link (`droppedLinkTyping`). After an image
 * the caret goes to the start of the next text. With no text after it, it goes
 * in the gap after the image, where typing starts a new line, and where Crepe
 * adds an empty last line at the end of the document. The image is never left
 * selected, where the next key would replace it.
 */
function placeCaret(tr: Transaction, end: number, endsInText: boolean): Transaction {
  const $end = tr.doc.resolve(end);
  if ($end.parent.inlineContent) return tr.setSelection(TextSelection.create(tr.doc, end)).setMeta(droppedTextEnd, end);
  const before = Selection.findFrom($end, -1, true);
  if (endsInText && before) return tr.setSelection(before).setMeta(droppedTextEnd, before.head);
  const after = Selection.findFrom($end, 1, true);
  if (after) return tr.setSelection(after);
  const gap = $end.parent.contentMatchAt($end.index()).defaultType?.isTextblock;
  return tr.setSelection(gap ? new GapCursor($end) : before ?? Selection.near($end));
}

/**
 * Leave the selection the user had before an insert, for a file that went in
 * while they were elsewhere. An end at the insert point stays before the
 * inserted content, so a selection never grows to take it in.
 */
function keepSelection(tr: Transaction, selection: Selection): Transaction {
  if (!(selection instanceof TextSelection)) return tr.setSelection(selection.map(tr.doc, tr.mapping));
  const anchor = tr.doc.resolve(tr.mapping.map(selection.anchor, -1));
  const head = tr.doc.resolve(tr.mapping.map(selection.head, -1));
  return tr.setSelection(TextSelection.between(anchor, head));
}

/**
 * Milkdown action that inserts Markdown's blocks at a drop target
 * (`placeBlocks`) and puts the caret after them (`placeCaret`), or with
 * `moveCaret` off leaves the selection where it was. The target moves past
 * the blocks, so the next file of the drop follows.
 */
export function insertBlocksAt(markdown: string, target: DropTarget, moveCaret = true) {
  return (ctx: Ctx): void => {
    const view = ctx.get(editorViewCtx);
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc?.lastChild) return;
    const { tr } = view.state;
    const { selection } = tr;
    if (!placeBlocks(tr, target, doc)) return;
    const end = changeEnd(tr);
    // The editor maps the target through this transaction. From where the
    // inserted blocks began, mapping takes it to their end.
    target.pos = tr.mapping.invert().map(end);
    if (!moveCaret) view.dispatch(keepSelection(tr, selection));
    else view.dispatch(placeCaret(tr, end, doc.lastChild.isTextblock).scrollIntoView());
  };
}

/** Whether a position is inside the text of a line, away from both ends,
 *  where a block put in would split the line. */
function insideText($pos: ResolvedPos): boolean {
  const { parent, parentOffset } = $pos;
  return parent.inlineContent && !parent.type.spec.code && parentOffset > 0 && parentOffset < parent.content.size;
}

/**
 * Milkdown action that inserts Markdown at the caret, for a file dropped away
 * from the document text (§5.4). A file never replaces what is selected, such
 * as the find card's current match. It goes in after the selected text, and
 * after a selected image or other block. Inside a line, a link joins the line
 * there, and an image goes in after the line, so the line is never split and
 * its rest never starts with a space, which Markdown would drop. At either end
 * of a line a file goes in as a block before or after it. The caret then goes
 * after the file (`placeCaret`), or with `moveCaret` off stays where it was,
 * before the file.
 */
export function insertAtSelection(markdown: string, moveCaret = true) {
  return (ctx: Ctx): void => {
    const view = ctx.get(editorViewCtx);
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc?.lastChild) return;
    const { tr } = view.state;
    const { selection } = tr;
    if (selection instanceof TextSelection) {
      const { $to } = selection;
      const inside = insideText($to);
      const joins = inside && doc.childCount === 1 && doc.firstChild?.type.name === "paragraph";
      tr.setSelection(TextSelection.create(tr.doc, inside && !joins ? $to.end() : $to.pos));
      // Open, the paragraph's text goes into the line. Closed, it is a block.
      const depth = joins ? 1 : 0;
      tr.replaceSelection(new Slice(doc.content, depth, depth));
    } else if (!placeBlocks(tr, { pos: selection.to }, doc)) {
      return;
    }
    if (!tr.docChanged) return;
    if (!moveCaret) view.dispatch(keepSelection(tr, selection));
    else view.dispatch(placeCaret(tr, changeEnd(tr), doc.lastChild.isTextblock).scrollIntoView());
  };
}

/** A change to Markdown source text, as offsets into it. */
export interface SourceEdit {
  from: number;
  to: number;
  insert: string;
  /** Which side of text inserted at a caret the caret stays on: -1 before
   *  the text, 1 after it. */
  assoc: -1 | 1;
}

/** A part of a Markdown body, as offsets into it. */
interface Span {
  start: number;
  end: number;
}

/** Where each top-level block of a Markdown body is in its text, as remark
 *  parses it, and where each link reference definition is, which the
 *  document has no block for. Null if remark gives a node no position. */
function sourceBlocks(ctx: Ctx, body: string): { blocks: Span[]; definitions: Span[] } | null {
  const blocks: Span[] = [];
  const definitions: Span[] = [];
  for (const node of ctx.get(remarkCtx).parse(body).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    (node.type === "definition" ? definitions : blocks).push({ start, end });
  }
  return { blocks, definitions };
}

/** How many line breaks `text` ends with, or begins with for `atStart`,
 *  with nothing but spaces and tabs between them. */
function lineBreaks(text: string, atStart: boolean): number {
  const [run] = (atStart ? /^(?:[ \t]*\n)*/ : /(?:\n[ \t]*)*$/).exec(text) ?? [""];
  return run.split("\n").length - 1;
}

/** The line breaks that give text put in between `before` and `after` a
 *  blank line on each side, apart from the start and the end of the body.
 *  Without one, the text could run on from the block before, as after a
 *  heading or a closing code fence, or the next block could run on from it. */
function blankLinesAround(before: string, after: string): [string, string] {
  const needed = (text: string, atStart: boolean): string =>
    /\S/.test(text) ? "\n".repeat(Math.max(0, 2 - lineBreaks(text, atStart))) : "";
  return [needed(before, false), needed(after, true)];
}

/**
 * The change to a document's Markdown source that matches one insert into the
 * document, which turned `before`, parsed from `body`, into `after`. The
 * split's Markdown pane makes it while the user types there, so the rest of
 * the source stays as written instead of in Milkdown's form. The top-level
 * blocks the insert changed are written in Milkdown's form, with a blank line
 * on each side. A list that would join a list next to it with the same
 * marker takes the other marker. The changed source must read back as
 * `after`. Null when it would not, as for text after a code fence that is not
 * closed yet, when it would take out a link reference definition, or when
 * the source's top-level blocks do not line up with the document's, as for an
 * empty body.
 */
export function sourceEditBetween(ctx: Ctx, before: Node, after: Node, body: string): SourceEdit | null {
  const source = sourceBlocks(ctx, body);
  if (!source?.blocks.length) return null;
  const { blocks, definitions } = source;
  // Crepe's empty last line has no source.
  const lastLine = blocks.length === before.childCount - 1 && isEmptyParagraph(before.lastChild);
  if (blocks.length !== before.childCount - (lastLine ? 1 : 0)) return null;
  // The insert turned blocks start to end of `before` into start to afterEnd of `after`.
  let start = 0;
  while (start < before.childCount && start < after.childCount && before.child(start).eq(after.child(start))) start += 1;
  let end = before.childCount;
  let afterEnd = after.childCount;
  while (end > start && afterEnd > start && before.child(end - 1).eq(after.child(afterEnd - 1))) {
    end -= 1;
    afterEnd -= 1;
  }
  const written: Node[] = [];
  for (let index = start; index < afterEnd; index += 1) written.push(after.child(index));
  const replaced = Math.min(end, blocks.length);
  // The changed blocks replace their source. New blocks go in after the block
  // before them, or before the first block. A caret at the end of the block
  // before stays there, and one at the start of the first block stays with it.
  const [from, to, assoc]: [number, number, -1 | 1] =
    start < replaced
      ? [blocks[start].start, blocks[replaced - 1].end, -1]
      : start === 0
        ? [blocks[0].start, blocks[0].start, 1]
        : [blocks[start - 1].end, blocks[start - 1].end, -1];
  if (definitions.some((definition) => definition.start < to && definition.end > from)) return null;
  const [open, close] = blankLinesAround(body.slice(0, from), body.slice(to));
  const serialize = ctx.get(serializerCtx);
  const parse = ctx.get(parserCtx);
  const shown = serialize(after).trimEnd();
  for (const text of writtenForms(serialize, after.type, written)) {
    const insert = open + text + close;
    const changed = body.slice(0, from) + insert + body.slice(to);
    if (serialize(parse(changed)).trimEnd() === shown) return { from, to, insert, assoc };
  }
  return null;
}

/**
 * The ways to write `blocks` in Milkdown's form, to try in turn. Written on
 * their own, a list takes the default marker, so it would join a list next to
 * it in the source with that marker. The second way writes a first block
 * that is a list with the other marker, as remark does after a list.
 */
function writtenForms(serialize: (doc: Node) => string, docType: Node["type"], blocks: Node[]): string[] {
  const write = (nodes: Node[]) => serialize(docType.create(null, nodes)).replace(/\n+$/, "");
  const alone = write(blocks);
  const forms = alone ? [alone] : [];
  if (isList(blocks[0])) {
    const lead = write([blocks[0]]);
    const led = write([blocks[0], ...blocks]);
    if (lead && led.startsWith(lead)) forms.push(led.slice(lead.length).replace(/^\n+/, ""));
  }
  return forms;
}

/** Whether two blocks hold the same content. Heading ids are left out, since
 *  Milkdown gives them to headings only after a parse. */
function sameBlock(a: Node, b: Node): boolean {
  if (a.eq(b)) return true;
  if (a.isText || a.childCount !== b.childCount) return false;
  const attrs = a.type.name === "heading" ? { ...b.attrs, id: a.attrs.id } : b.attrs;
  if (!a.hasMarkup(b.type, attrs, b.marks)) return false;
  for (let index = 0; index < a.childCount; index += 1) {
    if (!sameBlock(a.child(index), b.child(index))) return false;
  }
  return true;
}

/** Where each top-level block of a document starts, and its end last. */
function blockStarts(doc: Node): number[] {
  const starts = [0];
  doc.forEach((node) => starts.push(starts[starts.length - 1] + node.nodeSize));
  return starts;
}

/**
 * The part of the top-level blocks of `doc` from `from` to `to` that differs
 * from `changed`, the blocks that replace them, as positions in `doc` and
 * offsets into `changed`. Undefined when nothing differs. Null when replacing
 * only that part would not give exactly `changed`, as ProseMirror can add a
 * node, such as a table cell, to fit a cut through a table. Then the whole
 * blocks must be replaced.
 */
function changedPart(
  doc: Node,
  from: number,
  to: number,
  changed: Fragment,
): { from: number; to: number; start: number; end: number } | null | undefined {
  const old = doc.content.cut(from, to);
  const start = old.findDiffStart(changed);
  const diffEnd = old.findDiffEnd(changed);
  if (start == null || !diffEnd) return undefined;
  let { a, b } = diffEnd;
  // Repeated content can put the ends of the change before its start.
  const overlap = start - Math.min(a, b);
  if (overlap > 0) {
    a += overlap;
    b += overlap;
  }
  const part = { from: from + start, to: from + a, start, end: b };
  const blocks = doc.type.create(null, changed);
  const probe = new Transform(doc).replace(part.from, part.to, blocks.slice(start, b));
  const placed = probe.doc.content.size === doc.content.size - old.size + changed.size && probe.doc.content.cut(from, from + changed.size).eq(changed);
  return placed ? part : null;
}

/**
 * Milkdown action that mirrors Markdown into the document for a split mirror
 * sync. Unlike Milkdown's `replaceAll`, it replaces only the top-level blocks
 * that differ, each run of them on its own (`differingRuns`), and within a run
 * only the part that changed. Positions outside the changes keep their place
 * through the sync and through its undo and redo, and so do the caret, the
 * selection and the targets of drops. The user can be typing in this pane
 * while a file dropped on the Markdown pane goes in there. Then, with
 * `keepEditorOnly`, the blocks are compared as the document reads back from
 * its Markdown, so a block the sync does not change keeps what only the
 * editor holds, such as a space just typed at the end of a line, or a new
 * empty last line. `extend` can add steps to the same transaction, such as
 * the frontmatter's.
 */
export function mirrorMarkdown(
  markdown: string,
  keepEditorOnly: boolean,
  extend: (state: EditorState, tr: Transaction) => Transaction = (_state, tr) => tr,
) {
  return (ctx: Ctx): void => {
    const view = ctx.get(editorViewCtx);
    const parse = ctx.get(parserCtx);
    const next = parse(markdown);
    if (!next) return;
    const { state } = view;
    const { doc } = state;
    // The document as its Markdown reads back, block for block. The empty
    // lines at its end have no Markdown.
    let compared = doc;
    let count = doc.childCount;
    if (keepEditorOnly) {
      const read = parse(ctx.get(serializerCtx)(doc));
      let kept = doc.childCount;
      while (read && kept > read.childCount && isEmptyParagraph(doc.child(kept - 1))) kept -= 1;
      if (read && kept === read.childCount) {
        compared = read;
        count = kept;
      }
    }
    const runs = differingRuns(count, next.childCount, (a, b) => sameBlock(compared.child(a), next.child(b)), 50_000);
    const starts = blockStarts(doc);
    const nextStarts = blockStarts(next);
    const tr = state.tr;
    // From the last run back, so each run's positions still hold.
    for (const run of runs.reverse()) {
      const from = starts[run.fromA];
      const to = starts[run.toA];
      const nextFrom = nextStarts[run.fromB];
      const changed = next.content.cut(nextFrom, nextStarts[run.toB]);
      const narrowed = changedPart(doc, from, to, changed);
      if (narrowed === undefined) continue;
      if (narrowed) tr.replace(narrowed.from, narrowed.to, next.slice(nextFrom + narrowed.start, nextFrom + narrowed.end));
      else tr.replaceWith(from, to, changed);
    }
    if (tr.docChanged) keepSelection(tr, state.selection);
    const done = extend(state, tr);
    if (done.steps.length) view.dispatch(done);
  };
}
