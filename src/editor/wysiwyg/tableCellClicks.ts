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
// whose content is unchanged in place. After every update it closes a row or
// column menu whose selection is gone, which Crepe's view did not do when the
// content changed. app.css keeps a faded handle, and a menu left open in it,
// from taking a click unless the pointer reaches it from the table's cells.

import { TableNodeView } from "@milkdown/kit/component/table-block";
import type { Node } from "@milkdown/kit/prose/model";
import { CellSelection, findTable } from "@milkdown/kit/prose/tables";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $view } from "@milkdown/kit/utils";

/** Crepe's table view, without its own handling of a press in a cell, and
 *  keeping the cells of a table whose content has not changed. */
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

  /** Update the table in place when its content is unchanged, where Crepe's
   *  view returns false and so has ProseMirror draw it again. ProseMirror then
   *  redraws only the selection and highlights inside it. After any update,
   *  close a menu whose selection is gone. */
  override update(node: Node): boolean {
    if (node.eq(this.node)) {
      this.node = node;
      this.nodeRef.value = node;
    } else if (!super.update(node)) {
      return false;
    }
    this.closeStaleMenus(node);
    return true;
  }

  /** Close the row or column menu once its selection is gone. Drawing the
   *  table again did that when only the selection changed, but Crepe's view
   *  left the menu open when the content changed too, such as after a
   *  Markdown edit of a cell in the split. Its buttons act on the current
   *  selection, and its Delete removes rows for any cell selection that is
   *  not a column. */
  private closeStaleMenus(table: Node): void {
    const { selection } = this.view.state;
    const here = selection instanceof CellSelection && findTable(selection.$anchorCell)?.node === table;
    const open = {
      "col-drag-handle": here && selection.isColSelection(),
      "row-drag-handle": here && selection.isRowSelection(),
    };
    for (const [role, keep] of Object.entries(open)) {
      const menu = this.dom.querySelector<HTMLElement>(`[data-role="${role}"] .button-group`);
      if (menu && !keep) menu.dataset.show = "false";
    }
  }
}

/** Crepe's table node view with a click in a cell placing the caret, and the
 *  cells kept while only the selection in the table changes. Use it after
 *  Crepe's Table feature, whose settings the view reads, so it replaces
 *  Crepe's view. */
export const tableCellClicks = $view(
  tableSchema.node,
  (ctx) => (node, view, getPos) => new CaretTableView(ctx, node, view, getPos),
);
