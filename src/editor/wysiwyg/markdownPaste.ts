import { Fragment, type Node } from "@milkdown/kit/prose/model";
import { AllSelection, Selection, type EditorState } from "@milkdown/kit/prose/state";
import { CellSelection, selectedRect } from "@milkdown/kit/prose/tables";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { normalizeToLf, stripBom } from "../../document/lineEndings";

/** Splice Markdown into the selected body text, keeping the pasted source exact.
 *  A temporary word locates partial selections in the editor's Markdown. Like
 *  other document edits, this can normalize the surrounding changed block. */
export function pasteMarkdownSource(state: EditorState, markdown: string, write: (doc: Node) => string): string | null {
  const { doc, selection } = state;
  const inserted = normalizeToLf(stripBom(markdown)[0]);
  if (
    (doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0) ||
    selection instanceof AllSelection ||
    (selection.from <= Selection.atStart(doc).from && selection.to >= Selection.atEnd(doc).to)
  ) return inserted;

  const source = write(doc);
  let marker = "downpadpasteposition";
  while (source.includes(marker) || inserted.includes(marker)) marker += "x";
  const marked = write(state.tr.insertText(marker).doc);
  const at = marked.indexOf(marker);
  if (at < 0 || marked.indexOf(marker, at + marker.length) >= 0) return null;
  return marked.slice(0, at) + inserted + marked.slice(at + marker.length);
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
