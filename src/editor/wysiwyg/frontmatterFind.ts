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
//   - `changedCell` and `focusCaret` put the caret back at the text an undo or
//     redo changed in the table (frontmatterHistory.ts).

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

/** Write `key` as the new name of a field at a level whose keys are `siblings`,
 *  or return null when it would not stay a valid key or would repeat a sibling's
 *  key, which YAML does not allow. `siblings` follows each rename. */
function renameKey(key: string, current: string, siblings: Set<string>, rename: (key: string) => string): string | null {
  const next = key.trim();
  if (!isValidEditableKey(key) || /\s#/.test(next)) return null;
  if (next !== current && siblings.has(next)) return null;
  siblings.delete(current);
  siblings.add(next);
  return rename(next);
}

/** The cells FrontmatterPanel draws for `table`, top to bottom. */
function frontmatterCells(table: FrontmatterTable): FrontmatterCell[] {
  if (table.fields.length === 0) {
    // FrontmatterPanel's read-only fallback for YAML without fields.
    return table.raw.trim() ? [{ line: 0, part: "value", text: table.raw.replace(/\n+$/, "") }] : [];
  }
  const cells: FrontmatterCell[] = [];
  const scalar = (field: FmScalar, siblings: Set<string>): void => {
    cells.push(
      {
        line: field.lineIndex,
        part: "key",
        text: field.key,
        write: (key) =>
          renameKey(key, field.key, siblings, (next) => {
            field.key = next;
            return rewriteScalar(table, field);
          }),
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
  const topLevel = new Set(table.fields.map((field) => field.key));
  for (const field of table.fields) {
    if (field.kind === "scalar") {
      scalar(field, topLevel);
    } else if (field.kind === "group") {
      cells.push({
        line: field.headerIndex,
        part: "key",
        text: field.key,
        write: (key) =>
          renameKey(key, field.key, topLevel, (next) => {
            field.key = next;
            return rewriteGroupKey(table, field);
          }),
      });
      const children = new Set(field.children.map((child) => child.key));
      field.children.forEach((child) => scalar(child, children));
    } else {
      cells.push(
        { line: field.blockStart, part: "key", text: field.key },
        { line: field.blockStart, part: "value", text: field.display },
      );
    }
  }
  return cells;
}

/** A value cell's text split into the YAML scalar and what follows it on the
 *  line, which is empty or spaces and a comment. */
function splitValue(text: string): { scalar: string; rest: string } {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = closingQuote(text, quote);
    return end < 0 ? { scalar: text, rest: "" } : { scalar: text.slice(0, end + 1), rest: text.slice(end + 1) };
  }
  const comment = /\s#/.exec(text);
  const scalar = (comment ? text.slice(0, comment.index) : text).replace(/\s+$/, "");
  return { scalar, rest: text.slice(scalar.length) };
}

/** Index of the quote that closes a scalar opened by `quote` at index 0, or -1. */
function closingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (quote === "'" && text[i] === "'" && text[i + 1] === "'") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Whether `scalar` is one whole YAML scalar between `quote`s, closed by its last
 *  character, with only escapes YAML defines inside double quotes. */
function isQuotedScalar(scalar: string, quote: string): boolean {
  if (scalar[0] !== quote || closingQuote(scalar, quote) !== scalar.length - 1) return false;
  if (quote === "'") return true;
  for (let i = 1; i < scalar.length - 1; i++) {
    if (scalar[i] !== "\\") continue;
    const escape = /^(?:[0abtnvfre "/\\N_LP\t]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/.exec(scalar.slice(i + 1));
    if (!escape) return false;
    i += escape[0].length;
  }
  return true;
}

/** Whether YAML reads `scalar`, written unquoted after `key: `, as that text. */
function isPlainScalar(scalar: string): boolean {
  if (/^[,[\]{}#&*!|>'"%@`]/.test(scalar) || /^[-?:](\s|$)/.test(scalar)) return false;
  return !/:(\s|$)/.test(scalar) && !/\s#/.test(scalar);
}

/**
 * Whether replacing `matches` in a value cell's `text` with `replacement`
 * leaves a line YAML reads the same way: the scalar changes only where it
 * matched, a quoted scalar stays one whole scalar in the same quotes with valid
 * escapes, an unquoted one gains no comment, `: ` or leading indicator, and a
 * comment stays a comment.
 */
function keepsValueShape(text: string, matches: readonly FrontmatterMatch[], replacement: string): boolean {
  const before = splitValue(text);
  const end = before.scalar.length;
  if (matches.some((m) => m.from < end && m.to > end)) return false;
  const expected = matches
    .filter((m) => m.to <= end)
    .reduceRight((current, m) => current.slice(0, m.from) + replacement + current.slice(m.to), before.scalar);
  const after = splitValue(matches.reduceRight((current, m) => current.slice(0, m.from) + replacement + current.slice(m.to), text));
  if (after.scalar !== expected || (before.rest === "") !== (after.rest === "")) return false;
  const quote = before.scalar[0];
  if (quote === '"' || quote === "'") return isQuotedScalar(after.scalar, quote);
  return !isPlainScalar(before.scalar) || isPlainScalar(after.scalar);
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
 * and values are rewritten. Matches in read-only rows are left as they are, and
 * so are edits YAML would read differently: a key that would stop being a key
 * or repeat a sibling's key, and a value whose comment, quotes or plain text
 * would change shape. Returns `block` itself when nothing changed.
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
    if (cell.part === "value" && !keepsValueShape(cell.text, inCell, replacement)) continue;
    // From the last match back, so earlier offsets stay valid.
    const text = inCell.reduceRight(
      (current, m) => current.slice(0, m.from) + replacement + current.slice(m.to),
      cell.text,
    );
    if (text !== cell.text) result = cell.write(text) ?? result;
  }
  return result;
}

/**
 * The first cell where the table drawn for `after` shows other text than the
 * table drawn for `before`, with `from` just past the changed text. Null when
 * `after` shows the same text, or only lost cells at the end.
 */
export function changedCell(before: string, after: string): FrontmatterPosition | null {
  const was = frontmatterCells(parseFrontmatterTable(before));
  const cells = frontmatterCells(parseFrontmatterTable(after));
  const index = cells.findIndex(
    (cell, i) => cell.line !== was[i]?.line || cell.part !== was[i]?.part || cell.text !== was[i]?.text,
  );
  if (index < 0) return null;
  const { line, part, text } = cells[index];
  const old = was[index]?.text ?? "";
  // The change ends where the text both cells end with begins, but not inside
  // the text both start with.
  let start = 0;
  while (start < text.length && text[start] === old[start]) start++;
  let end = text.length;
  for (let o = old.length; end > start && o > start && text[end - 1] === old[o - 1]; o--) end--;
  return { line, part, from: end };
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

/** Focus the cell at `position`, scrolled into view if needed, with the caret
 *  at its offset. Returns false, and changes nothing, when the table does not
 *  show the cell or shows it read-only. */
export function focusCaret(panel: Element, position: FrontmatterPosition): boolean {
  const cell = cellOf(panel, position);
  const selection = window.getSelection();
  if (!cell?.isContentEditable || !selection) return false;
  let range = matchRange(panel, { ...position, to: position.from });
  if (!range) {
    // An empty cell has no text to hold the caret.
    range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
  }
  cell.focus();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
