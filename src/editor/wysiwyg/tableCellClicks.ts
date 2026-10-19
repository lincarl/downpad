// A click in a table cell puts the caret where it lands, as in a paragraph
// outside the table. Crepe's table view keeps a press on a cell's paragraph from
// ProseMirror and, unless the caret is already in that cell, selects the whole
// paragraph as a node a frame later. So a click on a cell's text, or in the
// space right of it, outlined the cell, and the next keystroke replaced all of
// its text. The press never reached prosemirror-tables either, so a drag from
// there across cells selected text instead of the cells.
//
// This view is Crepe's, except that it leaves a press inside the cells to
// ProseMirror, which places the caret, and to prosemirror-tables, which selects
// cells on a drag across them. The row and column handles sit outside the
// cells, so Crepe's view still handles their clicks and drags.

import { TableNodeView } from "@milkdown/kit/component/table-block";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $view } from "@milkdown/kit/utils";

/** Crepe's table view, without its own handling of a press in a cell. */
class CaretTableView extends TableNodeView {
  override stopEvent(event: Event): boolean {
    const { target, type } = event;
    const press = type === "mousedown" || type === "pointerdown";
    // A button inside a cell still keeps its press, as in Crepe's view.
    if (press && target instanceof Element && this.contentDOM.contains(target) && !target.closest("button")) {
      return false;
    }
    return super.stopEvent(event);
  }
}

/** Crepe's table node view with a click in a cell placing the caret. Use it
 *  after Crepe's Table feature, whose settings the view reads, so it replaces
 *  Crepe's view. */
export const tableCellClicks = $view(
  tableSchema.node,
  (ctx) => (node, view, getPos) => new CaretTableView(ctx, node, view, getPos),
);
