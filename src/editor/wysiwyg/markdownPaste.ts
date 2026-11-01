import { Fragment, Slice, type Node } from "@milkdown/kit/prose/model";
import { AllSelection, Selection, type EditorState } from "@milkdown/kit/prose/state";
import { Transform } from "@milkdown/kit/prose/transform";
import { CellSelection, selectedRect } from "@milkdown/kit/prose/tables";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { normalizeToLf, stripBom } from "../../document/lineEndings";

interface PasteSource {
  body: string;
  /** A document position, after any leading frontmatter has been separated. */
  caret: number;
}

interface PasteTools {
  write: (doc: Node) => string;
  serialize: (doc: Node) => string;
  parse: (source: string) => Node | null | undefined;
  /** Apply the same frontmatter handling as the editor that will render it. */
  bodyOf: (source: string) => string;
}

/** Splice Markdown into the selected body text, keeping compatible source exact.
 *  A temporary word locates partial selections in the editor's Markdown. Like
 *  other document edits, this can normalize the surrounding changed block. */
export function pasteMarkdownSource(state: EditorState, markdown: string, { write, serialize, parse, bodyOf }: PasteTools): PasteSource | null {
  const { doc, selection } = state;
  const inserted = normalizeToLf(stripBom(markdown)[0]);
  if (
    (doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0) ||
    selection instanceof AllSelection ||
    (selection.from <= Selection.atStart(doc).from && selection.to >= Selection.atEnd(doc).to)
  ) {
    const parsed = parse(bodyOf(inserted));
    return parsed ? { body: inserted, caret: Selection.atEnd(parsed).to } : null;
  }

  const source = write(doc);
  let marker = "downpadpasteposition";
  while (source.includes(marker) || inserted.includes(marker)) marker += "x";
  const marks = state.storedMarks ?? (selection.empty ? selection.$from.marks() : selection.$from.marksAcross(selection.$to)) ?? [];
  // Replacing a range from prose into code with inline text joins the code
  // suffix to the prose. Keep its code wrapper in both the source probe and
  // the rendered insertion used to repair conflicting marks.
  const codeTail = !selection.$from.sameParent(selection.$to) && selection.$to.parent.type.spec.code
    ? selection.$to.parent.copy(Fragment.empty)
    : null;
  const markerText = state.schema.text(marker, marks);
  const marked = write(codeTail
    ? state.tr.replaceSelection(new Slice(Fragment.fromArray([
      selection.$from.parent.copy(Fragment.from(markerText)), codeTail,
    ]), 1, 1)).doc
    : state.tr.insertText(marker).doc);
  const at = marked.indexOf(marker);
  if (at < 0 || marked.indexOf(marker, at + marker.length) >= 0) return null;
  let body = marked.slice(0, at) + inserted + marked.slice(at + marker.length);
  let end = at + inserted.length;
  const rendered = bodyOf(body);
  const parsed = parse(rendered);
  const clipboard = parse(inserted);
  if (!parsed || !clipboard) return null;

  let content = clipboard.content;
  // An image on its own parses as a block, but inside this paragraph it is
  // inline. Compare the splice with an insertion in that same context.
  if (clipboard.childCount === 1 && clipboard.firstChild?.type.name !== "paragraph" && selection.$from.sameParent(selection.$to)) {
    const wrapped = parse(`${marker} ${inserted} ${marker}`);
    const paragraph = wrapped?.childCount === 1 ? wrapped.firstChild : null;
    if (paragraph?.type.name === "paragraph" && paragraph.firstChild?.text?.startsWith(`${marker} `) && paragraph.lastChild?.text?.endsWith(` ${marker}`)) {
      content = Fragment.from(paragraph.copy(paragraph.content.cut(marker.length + 1, paragraph.content.size - marker.length - 1)));
    }
  }
  if (marks.length && content.childCount === 1 && content.firstChild?.type.name === "paragraph") {
    const inline: Node[] = [];
    content.firstChild.forEach((node) => inline.push(node.mark(node.marks.reduce((set, mark) => mark.addToSet(set), marks))));
    content = Fragment.from(content.firstChild.copy(Fragment.from(inline)));
  }
  const slice = Slice.maxOpen(content);
  const placed = state.tr.replaceSelection(codeTail
    ? new Slice(content.append(Fragment.from(codeTail)), slice.openStart, 1)
    : slice);
  const same = serialize(parsed) === serialize(placed.doc);
  // Splicing **new** into **left target right** would let its delimiters
  // close the surrounding bold mark. Serialize that edited block instead.
  if (marks.length && !same) {
    // Record the endpoint in the repaired source too. Serialization can
    // normalize nodes, so a position in `placed.doc` is not a source position.
    const endpoint = codeTail && placed.selection.$to.parent.type.spec.code
      ? Selection.near(placed.doc.resolve(placed.selection.$to.before()), -1).to
      : placed.selection.to;
    const repaired = write(placed.insertText(marker, endpoint).doc);
    end = repaired.indexOf(marker);
    if (end < 0 || repaired.indexOf(marker, end + marker.length) >= 0) return null;
    body = repaired.slice(0, end) + repaired.slice(end + marker.length);
  }
  const finalBody = bodyOf(body);
  const finalDoc = parse(finalBody);
  if (!finalDoc) return null;
  end = Math.max(0, end - (body.length - finalBody.length));
  return { body, caret: sourceCaret(finalBody, end, finalDoc, parse, marker) };
}

/** Locate a source endpoint without letting shared text shorten the paste.
 *  Accept a probe only when removing it gives the actual parsed document. */
function sourceCaret(source: string, end: number, doc: Node, parse: PasteTools["parse"], marker: string): number {
  for (const block of [false, true]) {
    const probe = block ? `\n\n${marker}\n\n` : marker;
    const marked = parse(source.slice(0, end) + probe + source.slice(end));
    if (!marked) continue;
    let found: number | null = null;
    marked.descendants((node, pos) => {
      if (found !== null) return false;
      if (block && node.type.name === "paragraph" && node.textContent === marker) {
        if (new Transform(marked).delete(pos, pos + node.nodeSize).doc.eq(doc)) found = pos;
        return false;
      }
      if (!block && node.isText) {
        const at = node.text!.indexOf(marker);
        if (at >= 0 && new Transform(marked).delete(pos + at, pos + at + marker.length).doc.eq(doc)) found = pos + at;
      }
      return true;
    });
    if (found !== null) return found;
  }
  // An endpoint in invisible syntax, such as a reference definition, has no
  // text caret. Use the end of the preceding rendered content.
  const prefix = parse(source.slice(0, end));
  return prefix ? Math.min(Selection.atEnd(prefix).to, doc.content.size) : Selection.atEnd(doc).to;
}

/** Paste a Markdown rectangle into selected cells without changing their types.
 *  Milkdown requires separate header and body cell types, so replacing whole
 *  cells with the clipboard's types can split the surrounding table. */
export function pasteMarkdownCells(view: EditorView, parsed: Node): boolean {
  const { state } = view;
  if (!(state.selection instanceof CellSelection)) return false;
  const table = parsed.childCount === 1 && parsed.firstChild?.type.spec.tableRole === "table" ? parsed.firstChild : null;
  const rows: Fragment[][] = [];
  if (table) {
    table.forEach((row) => {
      const cells: Fragment[] = [];
      row.forEach((cell) => cells.push(cell.content));
      if (cells.length) rows.push(cells);
    });
  } else {
    let inline = Fragment.empty;
    let supported = true;
    parsed.descendants((node) => {
      if (!node.isTextblock) {
        if (node.isLeaf) supported = false;
        return true;
      }
      if (inline.size) inline = inline.append(Fragment.from(state.schema.nodes.hardbreak.create()));
      inline = inline.append(node.content);
      return false;
    });
    if (!supported || !inline.size) return false;
    rows.push([Fragment.from(state.schema.nodes.paragraph.create(null, inline))]);
  }
  if (!rows.length) return false;
  const rect = selectedRect(state);
  const tr = state.tr;
  state.selection.forEachCell((cell, pos) => {
    const { top, left } = rect.map.findCell(pos - rect.tableStart);
    const row = rows[(top - rect.top) % rows.length]!;
    const content = row[(left - rect.left) % row.length]!;
    tr.replaceWith(tr.mapping.map(pos + 1), tr.mapping.map(pos + cell.nodeSize - 1), content);
  });
  tr.setSelection(state.selection.map(tr.doc, tr.mapping));
  view.dispatch(closeHistory(tr).setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
  return true;
}
