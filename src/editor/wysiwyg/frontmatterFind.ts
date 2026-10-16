// Find and replace in the frontmatter table (spec §5.13, §5.17). The table
// shows the YAML block outside ProseMirror, so the document view's find card
// searches it here:
//   - `findInFrontmatter` matches the text each cell of FrontmatterPanel shows,
//     taken from the parsed table model, so the counts are right even before
//     React has redrawn the table.
//   - `replaceInFrontmatter` writes replaced keys and values back through the
//     table's own one-line rewrites, so the rest of the YAML keeps its form.
//     Read-only rows (lists, deeper nesting) are found but never replaced.
//   - `matchRange`, `revealCell` and `focusMatch` locate a match in the drawn
//     table by the data-line and data-part attributes FrontmatterPanel puts on
//     each cell.

import {
  isValidEditableKey,
  parseFrontmatterTable,
  rewriteGroupKey,
  rewriteScalar,
  type FmScalar,
  type FrontmatterTable,
} from "../../document/frontmatterTable";
import { findMatchRanges, type FindOptions } from "./findEngine";

/** Which text of a table row a match is in. */
export type FrontmatterPart = "key" | "value";

/** A place in the table's text, given as a row's key or value cell and an offset in it. */
export interface FrontmatterPosition {
  /** Inner YAML line of the row, which is the scalar line, the mapping header
   *  or the first line of read-only text. */
  line: number;
  part: FrontmatterPart;
  from: number;
}

/** A find match in the text of one table cell. */
export interface FrontmatterMatch extends FrontmatterPosition {
  to: number;
}

/** The text one table cell shows, and how Replace writes new text back. */
interface FrontmatterCell {
  line: number;
  part: FrontmatterPart;
  text: string;
  /** Write the cell's new text into the table's YAML lines and return the
   *  rebuilt block, or null when the text cannot go there. Absent when the
   *  cell is read-only. */
  write?: (text: string) => string | null;
}

/** The cells FrontmatterPanel draws for `table`, top to bottom. */
function frontmatterCells(table: FrontmatterTable): FrontmatterCell[] {
  if (table.fields.length === 0) {
    // FrontmatterPanel's read-only fallback for YAML without fields.
    return table.raw.trim() ? [{ line: 0, part: "value", text: table.raw.replace(/\n+$/, "") }] : [];
  }
  const cells: FrontmatterCell[] = [];
  const scalar = (field: FmScalar): void => {
    cells.push(
      {
        line: field.lineIndex,
        part: "key",
        text: field.key,
        write: (key) => {
          if (!isValidEditableKey(key)) return null;
          field.key = key.trim();
          return rewriteScalar(table, field);
        },
      },
      {
        line: field.lineIndex,
        part: "value",
        text: field.value,
        write: (value) => {
          field.value = value;
          return rewriteScalar(table, field);
        },
      },
    );
  };
  for (const field of table.fields) {
    if (field.kind === "scalar") {
      scalar(field);
    } else if (field.kind === "group") {
      cells.push({
        line: field.headerIndex,
        part: "key",
        text: field.key,
        write: (key) => {
          if (!isValidEditableKey(key)) return null;
          field.key = key.trim();
          return rewriteGroupKey(table, field);
        },
      });
      field.children.forEach(scalar);
    } else {
      cells.push(
        { line: field.blockStart, part: "key", text: field.key },
        { line: field.blockStart, part: "value", text: field.display },
      );
    }
  }
  return cells;
}

/** Matches of `query` in the frontmatter table drawn for `block`, top to bottom. */
export function findInFrontmatter(block: string, query: string, opts: FindOptions): FrontmatterMatch[] {
  if (!query) return [];
  return frontmatterCells(parseFrontmatterTable(block)).flatMap(({ line, part, text }) =>
    findMatchRanges(text, query, opts).map(({ from, to }) => ({ line, part, from, to })),
  );
}

/**
 * Replace `matches` (from `findInFrontmatter` on the same block) with
 * `replacement` and return the rewritten block. Only the lines of changed keys
 * and values are rewritten. Matches in read-only rows, and key edits that would
 * not stay a valid key, are left as they are. Returns `block` itself when
 * nothing changed.
 */
export function replaceInFrontmatter(
  block: string,
  matches: readonly FrontmatterMatch[],
  replacement: string,
): string {
  const table = parseFrontmatterTable(block);
  let result = block;
  for (const cell of frontmatterCells(table)) {
    const inCell = matches.filter((m) => m.line === cell.line && m.part === cell.part);
    if (!cell.write || inCell.length === 0) continue;
    // From the last match back, so earlier offsets stay valid.
    const text = inCell.reduceRight(
      (current, m) => current.slice(0, m.from) + replacement + current.slice(m.to),
      cell.text,
    );
    if (text !== cell.text) result = cell.write(text) ?? result;
  }
  return result;
}

/** Whether `a` comes before `b` in the table, top to bottom and key before value. */
export function isBefore(a: FrontmatterPosition, b: FrontmatterPosition): boolean {
  if (a.line !== b.line) return a.line < b.line;
  if (a.part !== b.part) return a.part === "key";
  return a.from < b.from;
}

/** The drawn cell that shows `match`, or null when the table does not show it. */
function cellOf(panel: Element, match: FrontmatterPosition): HTMLElement | null {
  return panel.querySelector<HTMLElement>(`[data-line="${match.line}"][data-part="${match.part}"]`);
}

/** A DOM range over `match` in the drawn table, or null when the cell is
 *  missing or shorter than the match (a redraw is still pending). */
export function matchRange(panel: Element, match: FrontmatterMatch): Range | null {
  const cell = cellOf(panel, match);
  if (!cell) return null;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + (node.textContent?.length ?? 0);
    if (!started && match.from <= end) {
      range.setStart(node, match.from - offset);
      started = true;
    }
    if (started && match.to <= end) {
      range.setEnd(node, match.to - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

/** Scroll the cell that shows `match` to the middle of its scrolling page,
 *  unless all of it is already in view. */
export function revealCell(panel: Element, match: FrontmatterPosition): void {
  const cell = cellOf(panel, match);
  if (!cell) return;
  const box = cell.getBoundingClientRect();
  for (let el = cell.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
    const view = el.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) return;
    break;
  }
  // jsdom has no scrollIntoView, so the call is optional.
  cell.scrollIntoView?.({ block: "center", inline: "nearest" });
}

/** Focus the cell that shows `match` and select the match, so the next
 *  keystroke replaces it. Returns false, and changes nothing, when the table
 *  does not show the match or shows it read-only. */
export function focusMatch(panel: Element, match: FrontmatterMatch): boolean {
  const cell = cellOf(panel, match);
  const range = matchRange(panel, match);
  const selection = window.getSelection();
  if (!cell?.isContentEditable || !range || !selection) return false;
  cell.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
