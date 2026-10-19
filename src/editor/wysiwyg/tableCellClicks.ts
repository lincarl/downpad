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
//
// Crepe's view also has ProseMirror draw a table again, with new cells, when
// only the selection or highlights in it change, such as a cell selection
// starting or ending. In the split, the press of a click in the document pane
// right after a Markdown edit first brings that pane up to date, which ends its
// cell selection. The cell the press landed on was then gone, so the click
// placed no caret and the focus left both panes. This view updates a table
// whose content is unchanged in place, unless a whole row or column is selected
// in it. Crepe's new view opens the menu of a selected row or column, such as
// after a click on its handle or on the button that adds it, so the table is
// still drawn again then. After every other update this view closes a row or
// column menu whose selection is gone, which Crepe's view did not do when the
// content changed. Crepe fades the handles once the pointer leaves the table
// and leaves them, with any menu open in them, where they were. A faded handle
// shows again under the pointer before it takes a click, so a menu left open
// after its selection was gone could select a column from the paragraph above.

import { TableNodeView } from "@milkdown/kit/component/table-block";
import type { Node } from "@milkdown/kit/prose/model";
import { CellSelection, findTable } from "@milkdown/kit/prose/tables";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $view } from "@milkdown/kit/utils";

/** Whether the selection is a whole row, and a whole column, of a table. */
interface SelectedLines {
  row: boolean;
  col: boolean;
}

/** Crepe's table view, without its own handling of a press in a cell, and
 *  keeping the cells of a table whose content has not changed while no whole
 *  row or column is selected in it. */
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

  /** Update the table in place when its content is unchanged and no whole row
   *  or column is selected in it, where Crepe's view returns false and so has
   *  ProseMirror draw it again. ProseMirror then redraws only the selection and
   *  highlights inside it. While a whole row or column is selected, Crepe's
   *  view still has the table drawn again, because its new view opens the
   *  menu of that row or column. After an update that keeps this view, close
   *  a menu whose selection is gone. */
  override update(node: Node): boolean {
    const lines = this.selectedLines(node);
    if (!node.eq(this.node) || lines.row || lines.col) {
      if (!super.update(node)) return false;
    } else {
      this.node = node;
      this.nodeRef.value = node;
    }
    this.closeStaleMenus(lines);
    return true;
  }

  /** Whether the selection is a whole row, and a whole column, of `table`. */
  private selectedLines(table: Node): SelectedLines {
    const { selection } = this.view.state;
    const here = selection instanceof CellSelection && findTable(selection.$anchorCell)?.node === table;
    return { row: here && selection.isRowSelection(), col: here && selection.isColSelection() };
  }

  /** Close the row or column menu once its selection is gone. Drawing the
   *  table again did that when only the selection changed, but Crepe's view
   *  left the menu open when the content changed too, such as after a
   *  Markdown edit of a cell in the split. Its buttons act on the current
   *  selection, and its Delete removes rows for any cell selection that is
   *  not a column. */
  private closeStaleMenus(lines: SelectedLines): void {
    const open = { "col-drag-handle": lines.col, "row-drag-handle": lines.row };
    for (const [role, keep] of Object.entries(open)) {
      const menu = this.dom.querySelector<HTMLElement>(`[data-role="${role}"] .button-group`);
      if (menu && !keep) menu.dataset.show = "false";
    }
  }
}

/** Crepe's table node view with a click in a cell placing the caret, and the
 *  cells kept while only the selection in the table changes, unless it becomes
 *  a whole row or column. Use it after
 *  Crepe's Table feature, whose settings the view reads, so it replaces
 *  Crepe's view. */
export const tableCellClicks = $view(
  tableSchema.node,
  (ctx) => (node, view, getPos) => new CaretTableView(ctx, node, view, getPos),
);
