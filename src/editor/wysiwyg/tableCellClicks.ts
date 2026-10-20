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
//
// A menu's buttons act on pointerdown, and the click after them reaches the
// handle, which selects the row or column at its place. After a row's Delete,
// that is the row that moved up, and Crepe's new view opens its menu, so
// Delete again removes that row too. The Delete itself ends the row selection,
// so closing the menu right then hid the button under the pointer before the
// release. The click then landed on the cell below, and no row was selected.
// While a press that started on a row or column handle, or in its menu, lasts,
// this view therefore closes a stale menu only once the press and its click
// are over.
//
// Crepe's view also keeps every drag event in the table from ProseMirror, and
// cancels dragover there but not dragenter. Chromium sends only a dragenter
// when the element under the pointer changes, as it does on every update while
// the page scrolls under a still pointer. With that last update not cancelled,
// a block dragged by its handle onto a cell was dropped by Chromium itself,
// which put a copy of the block's text into the cell, and the block stayed
// where it was. This view leaves the events of a drag that ProseMirror started
// to ProseMirror, which cancels the dragenter and puts the drop in above or
// below the table (dropEdge.ts). The table keeps the drags of its own row and
// column handles, and other drops on it, as before.

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

/** Crepe's row and column handles, each of which holds its menu. */
const lineHandles = '[data-role="col-drag-handle"], [data-role="row-drag-handle"]';

/** Crepe's table view, without its own handling of a press in a cell or of a
 *  drag that ProseMirror started, and keeping the cells of a table whose
 *  content has not changed while no whole row or column is selected in it. */
class CaretTableView extends TableNodeView {
  /** Whether a press that started on a row or column handle, or in its menu,
   *  has not yet ended with its click. */
  private pressOnHandle = false;
  /** Whether an update during that press left a stale menu to close. */
  private closeAfterPress = false;
  /** The timer that ends the press once its click is over. */
  private pressEnd: ReturnType<typeof setTimeout> | undefined;

  constructor(...args: ConstructorParameters<typeof TableNodeView>) {
    super(...args);
    // In the capture phase, before Crepe's buttons act on the press.
    this.dom.addEventListener("pointerdown", this.startPress, true);
  }

  override destroy(): void {
    window.removeEventListener("pointerup", this.endPress, true);
    window.removeEventListener("pointercancel", this.endPress, true);
    clearTimeout(this.pressEnd);
    super.destroy();
  }

  /** Note a press on a row or column handle, or in its menu, until it ends. */
  private readonly startPress = (event: PointerEvent): void => {
    if (!(event.target instanceof Element) || !event.target.closest(lineHandles)) return;
    clearTimeout(this.pressEnd);
    this.pressOnHandle = true;
    window.addEventListener("pointerup", this.endPress, true);
    window.addEventListener("pointercancel", this.endPress, true);
  };

  /** Close the menus the press left stale once its click is over. The click
   *  comes after pointerup in the same task. */
  private readonly endPress = (): void => {
    window.removeEventListener("pointerup", this.endPress, true);
    window.removeEventListener("pointercancel", this.endPress, true);
    this.pressEnd = setTimeout(() => {
      this.pressOnHandle = false;
      if (!this.closeAfterPress) return;
      this.closeAfterPress = false;
      this.closeStaleMenus(this.selectedLines(this.node));
    });
  };

  override stopEvent(event: Event): boolean {
    const { target, type } = event;
    // ProseMirror takes the events of a drag it started, such as a block
    // dragged by its handle, here as anywhere else, so it cancels the
    // dragenter and puts the drop in above or below the table (dropEdge.ts).
    if (this.view.dragging && (type === "drop" || type.startsWith("drag"))) return false;
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
   *  a menu whose selection is gone, or, during a press on a row or column
   *  handle or in its menu, once that press and its click are over. */
  override update(node: Node): boolean {
    const lines = this.selectedLines(node);
    if (!node.eq(this.node) || lines.row || lines.col) {
      if (!super.update(node)) return false;
    } else {
      this.node = node;
      this.nodeRef.value = node;
    }
    if (this.pressOnHandle) this.closeAfterPress = true;
    else this.closeStaleMenus(lines);
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

/** Crepe's table node view with a click in a cell placing the caret, the
 *  drop of a block or text dragged within the document left to ProseMirror,
 *  and the cells kept while only the selection in the table changes, unless
 *  it becomes a whole row or column. Use it after Crepe's Table feature, whose
 *  settings the view reads, so it replaces Crepe's view. */
export const tableCellClicks = $view(
  tableSchema.node,
  (ctx) => (node, view, getPos) => new CaretTableView(ctx, node, view, getPos),
);
