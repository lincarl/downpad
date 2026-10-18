// Block-level pagination for the custom print path (spec §5.21).
//
// The document is laid out once, at the exact content width of a page, and its
// top-level blocks are then packed into page-sized groups. Breaks only ever fall
// *between* blocks, so a printed page never cuts a line of text in half the way
// a naive fixed-height clip would — this is what makes the output read like a
// document rather than a screenshot of a scrolling page.
//
// Blocks that are themselves taller than a page (a long table, a long list, a
// long code block, a Markdown source line that wraps past a page) are split one
// level down first, so the packer always has pieces it can place.

/** Rebuilt-from-lines code blocks lose inline highlight markup; see splitPre. */
const CODE_LINE_CLASS = "print-code-line";

/** One line of Markdown source in the Markdown version (printRender.ts). */
export const SOURCE_LINE_CLASS = "print-src-line";

/**
 * Group `flow`'s children into pages of at most `contentHeightPx`.
 *
 * `flow` must already be laid out in the document at the final content width —
 * the grouping is measured, not estimated. Returns one array of elements per
 * page, in order; the elements are still children of `flow` (the caller moves
 * them into page containers).
 */
export function splitIntoPages(flow: HTMLElement, contentHeightPx: number): Element[][] {
  splitOversized(flow, contentHeightPx);
  return packByHeight(Array.from(flow.children), contentHeightPx);
}

/**
 * Pack laid-out siblings into groups no taller than `maxHeightPx`.
 *
 * Heights come from `offsetTop`/`offsetHeight`, i.e. border boxes. The first
 * block's top margin must be added back for each page: `.print-page-body` creates
 * a block formatting context with `overflow: hidden`, so that margin is contained
 * by (and consumes space in) the page rather than collapsing outside it. An
 * element taller than the limit gets a group to itself rather than an empty page
 * before it.
 */
export function packByHeight(items: Element[], maxHeightPx: number): Element[][] {
  const boxes = items.map((item) => {
    const el = item as HTMLElement;
    const marginTop = Number.parseFloat(getComputedStyle(el).marginTop) || 0;
    return { top: el.offsetTop, height: el.offsetHeight, marginTop };
  });
  return packBoxes(boxes, maxHeightPx).map((group) => group.map((i) => items[i]));
}

/** One laid-out item's vertical extent, as the packer sees it. */
interface Box {
  top: number;
  height: number;
  /** Only ordinary flow blocks need this; derived line boxes have no margin. */
  marginTop?: number;
}

/**
 * The packing itself, over measurements rather than elements, so a caller that
 * has to *derive* an item's height can still use it — see splitCodeMirror, where
 * a source line is as tall as the taller of the text and its gutter number.
 * Returns groups of indices into `boxes`.
 */
function packBoxes(boxes: Box[], maxHeightPx: number): number[][] {
  const pages: number[][] = [];
  let current: number[] = [];
  let origin = 0;
  boxes.forEach((box, index) => {
    const bottom = box.top + box.height;
    if (!current.length) {
      origin = box.top - (box.marginTop ?? 0);
      current.push(index);
      return;
    }
    if (bottom - origin <= maxHeightPx) {
      current.push(index);
      return;
    }
    pages.push(current);
    current = [index];
    origin = box.top - (box.marginTop ?? 0);
  });
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

/** Replace any child taller than a page with a sequence of page-sized pieces. */
function splitOversized(flow: HTMLElement, contentHeightPx: number): void {
  // Snapshot first: the list is mutated while splitting.
  for (const child of Array.from(flow.children)) {
    const el = child as HTMLElement;
    if (el.offsetHeight <= contentHeightPx) continue;
    const pieces = splitBlock(el, contentHeightPx);
    if (!pieces.length) continue;
    el.replaceWith(...pieces);
  }
}

/**
 * Split one over-tall block into pieces, or [] when it can't be split.
 *
 * The block is a child of the document flow, which is not always the splittable
 * element itself: Crepe wraps a table in
 * `div.milkdown-table-block > div > div.table-wrapper`, so dispatching on the
 * block's own tag name matched nothing and left an over-tall table to be clipped
 * at the page edge, losing its last rows. Look inside the block, split what is
 * found, then rebuild the wrappers around each piece.
 */
function splitBlock(el: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const inner = splittableIn(el);
  if (!inner) return [];
  // The wrappers occupy height of their own (padding, borders, sibling chrome);
  // leave room for it so a rebuilt piece still fits on the page.
  const overhead = Math.max(0, el.offsetHeight - inner.offsetHeight);
  const pieces = splitElement(inner, Math.max(1, maxHeightPx - overhead));
  if (inner === el) return pieces;
  return pieces.map((piece) => rewrap(el, inner, piece));
}

/** Dispatch to the splitter for one element's own kind. */
function splitElement(el: HTMLElement, maxHeightPx: number): HTMLElement[] {
  if (el.classList.contains("cm-scroller")) return splitCodeMirror(el, maxHeightPx);
  if (el.classList.contains(SOURCE_LINE_CLASS)) return splitSourceLine(el, maxHeightPx);
  switch (el.tagName) {
    case "TABLE":
      return splitTable(el as HTMLTableElement, maxHeightPx);
    case "UL":
    case "OL":
      return splitList(el, maxHeightPx);
    case "PRE":
      return splitPre(el, maxHeightPx);
    default:
      return [];
  }
}

/**
 * The element inside a block that pagination knows how to split, or the block
 * itself when it is one. The tallest candidate wins: a block can hold more than
 * one, and only the one that makes it over-tall is worth splitting.
 */
function splittableIn(block: HTMLElement): HTMLElement | null {
  if (SPLITTABLE_TAGS.has(block.tagName) || block.classList.contains(SOURCE_LINE_CLASS)) {
    return block;
  }
  let tallest: HTMLElement | null = null;
  for (const el of block.querySelectorAll<HTMLElement>(SPLITTABLE_SELECTOR)) {
    if (!tallest || el.offsetHeight > tallest.offsetHeight) tallest = el;
  }
  return tallest;
}

const SPLITTABLE_TAGS = new Set(["TABLE", "UL", "OL", "PRE"]);

/** `.cm-scroller` is Crepe's code block: CodeMirror, not a `<pre>` (splitCodeMirror). */
const SPLITTABLE_SELECTOR = "table, ul, ol, pre, .cm-scroller";

/**
 * Rebuild `block` around one piece of its split content. Every wrapper between
 * the block and the split element is shallow-cloned, so each piece keeps the
 * classes and attributes Crepe's styles key off.
 */
function rewrap(block: HTMLElement, inner: HTMLElement, piece: HTMLElement): HTMLElement {
  let wrapped = piece;
  for (
    let level = inner.parentElement;
    level && level !== block.parentElement;
    level = level.parentElement
  ) {
    const clone = level.cloneNode(false) as HTMLElement;
    clone.appendChild(wrapped);
    wrapped = clone;
  }
  return wrapped;
}

/**
 * Split a table between rows, repeating its header on every piece.
 *
 * The header comes in two shapes. Crepe renders markdown tables with every row in
 * one `<tbody>`, marking the header with `data-is-header` — so `table.tHead` is
 * null for the tables this app actually prints, and reading only `tHead` left
 * every page after the first headerless. Pasted HTML can still carry a real
 * `<thead>`. Both are repeated, each rebuilt in the structure it came from.
 */
function splitTable(table: HTMLTableElement, maxHeightPx: number): HTMLTableElement[] {
  // Pin the source table to the geometry its pieces will use *before* measuring
  // anything. The pieces are laid out `fixed` at frozen widths while the source
  // is `auto`, and a cell can wrap onto an extra line in one and not the other —
  // packing against the source's own row heights then overflowed the page by the
  // difference, and the page box clips.
  const frozen = frozenColumns(table);
  applyFrozenColumns(table, frozen);

  const head = tableHeader(table);
  const bodyRows = Array.from(
    table.querySelectorAll<HTMLTableRowElement>("tbody > tr, :scope > tr"),
  ).filter((row) => row !== head.row);
  if (bodyRows.length < 2) return [];
  const groups = packByHeight(bodyRows, Math.max(1, maxHeightPx - head.heightPx));
  if (groups.length < 2) return [];

  // Rows keep the container they came from: Crepe's `<tbody>` carries attributes
  // its own styles key off, so a bare replacement would restyle the split pieces.
  // A row with no container of its own goes straight into the table.
  const parent = bodyRows[0].parentElement;
  const container = parent && parent !== table ? parent : null;

  return groups.map((rows) => {
    const piece = table.cloneNode(false) as HTMLTableElement;
    applyFrozenColumns(piece, frozen);
    if (head.section) piece.appendChild(head.section.cloneNode(true));
    const body = container ? (container.cloneNode(false) as HTMLElement) : piece;
    if (head.row && !head.section) body.appendChild(head.row.cloneNode(true));
    for (const row of rows) body.appendChild(row);
    if (body !== piece) piece.appendChild(body);
    return piece;
  });
}

/** A table's repeatable header, however the table happens to express it. */
interface TableHeader {
  /** The `<thead>`, when the header is a real section; cloned whole. */
  section: HTMLTableSectionElement | null;
  /** The header row itself, wherever it lives; null when the table has none. */
  row: HTMLTableRowElement | null;
  /** Its laid-out height, reserved on every piece before rows are packed. */
  heightPx: number;
}

function tableHeader(table: HTMLTableElement): TableHeader {
  const section = table.tHead;
  if (section) {
    return { section, row: section.rows[0] ?? null, heightPx: section.offsetHeight };
  }
  const first = table.querySelector<HTMLTableRowElement>("tbody > tr, :scope > tr");
  const row = first && isHeaderRow(first) ? first : null;
  return { section: null, row, heightPx: row ? row.offsetHeight : 0 };
}

/**
 * Whether a row is the table's header: Crepe says so outright, and a row of
 * nothing but `<th>` means the same thing in plain HTML. A table whose first row
 * is ordinary data has no header to repeat, which is a valid shape, not an error.
 */
function isHeaderRow(row: HTMLTableRowElement): boolean {
  if (row.dataset.isHeader === "true") return true;
  const cells = Array.from(row.cells);
  return cells.length > 0 && cells.every((cell) => cell.tagName === "TH");
}

/** The widths a table was actually laid out with, plus its total width. */
interface FrozenColumns {
  widthPx: number;
  columnPx: number[];
}

/**
 * Capture the column widths of a laid-out table so every piece of a split can be
 * pinned to them. Table columns size to their content (`table-layout: auto`,
 * app.css §6.2), so a piece re-measured against only its own rows would come out
 * a different shape from the piece above it. Returns null when there is nothing
 * to measure, or when merged cells make a per-column reading meaningless
 * (markdown tables have none, so this is a guard, not a supported case).
 */
function frozenColumns(table: HTMLTableElement): FrozenColumns | null {
  const row = table.rows[0];
  if (!row || row.cells.length === 0) return null;
  const cells = Array.from(row.cells);
  if (cells.some((cell) => cell.colSpan > 1)) return null;
  return { widthPx: table.offsetWidth, columnPx: cells.map((cell) => cell.offsetWidth) };
}

/** Pin a table to measured geometry via a `<colgroup>`, its required first child. */
function applyFrozenColumns(table: HTMLTableElement, frozen: FrozenColumns | null): void {
  if (!frozen) return;
  table.style.tableLayout = "fixed";
  table.style.width = `${frozen.widthPx}px`;
  const group = document.createElement("colgroup");
  for (const width of frozen.columnPx) {
    const col = document.createElement("col");
    col.style.width = `${width}px`;
    group.appendChild(col);
  }
  table.insertBefore(group, table.firstChild);
}

/**
 * Split a list between items, continuing the numbering on ordered lists.
 *
 * An item is not always an `<li>`: Crepe renders each one as
 * `<ul><div class="milkdown-list-item-block"><li>…`, so matching only `LI`
 * children found nothing and left a long list to be clipped at the page edge.
 * Crepe draws its own bullets and numbers into those wrappers, so the numbering
 * travels with the items; `start` still carries it for plain HTML lists.
 */
function splitList(list: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const items = Array.from(list.children).filter(
    (c) => c.tagName === "LI" || c.querySelector("li") !== null,
  );
  if (items.length < 2) return [];
  const groups = packByHeight(items, maxHeightPx);
  if (groups.length < 2) return [];
  let index = Number((list as HTMLOListElement).start) || 1;
  return groups.map((group) => {
    const piece = list.cloneNode(false) as HTMLElement;
    if (list.tagName === "OL") (piece as HTMLOListElement).start = index;
    index += group.length;
    for (const item of group) piece.appendChild(item);
    return piece;
  });
}

/**
 * Split a Crepe code block between source lines.
 *
 * Crepe renders code through CodeMirror, not a `<pre>`, so `splitPre` never
 * matched it and an over-tall code block was clipped at the page edge. The split
 * happens at the `.cm-scroller`, one level above the text, because the line-number
 * gutter is the scroller's other child and has to be cut at the same place — the
 * numbers on page two must be the numbers of the lines on page two.
 *
 * The `.cm-line` elements are *moved* into the pieces, so syntax highlighting
 * survives intact (unlike `splitPre`, which can only rebuild from text).
 */
function splitCodeMirror(scroller: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const content = scroller.querySelector<HTMLElement>(".cm-content");
  if (!content) return [];
  const lines = Array.from(content.children) as HTMLElement[];
  if (lines.length < 2) return [];

  const gutters = scroller.querySelector<HTMLElement>(".cm-gutters");
  const lineSum = lines.reduce((total, line) => total + line.offsetHeight, 0);
  // Whatever height the content box has beyond its lines is padding that every
  // piece pays; charge it up front rather than trying to apportion it. The gutter
  // column needs no allowance of its own: each number's box is pinned to the height
  // of the line it labels (gutterSlice), so it can never outgrow the text.
  const padding = Math.max(0, content.offsetHeight - lineSum);

  let stacked = 0;
  const boxes = lines.map((line) => {
    const box = { top: stacked, height: line.offsetHeight };
    stacked += line.offsetHeight;
    return box;
  });
  const groups = packBoxes(boxes, Math.max(1, maxHeightPx - padding)).map((group) =>
    group.map((i) => lines[i]),
  );
  if (groups.length < 2) return [];

  let first = 0;
  return groups.map((group) => {
    const piece = scroller.cloneNode(false) as HTMLElement;
    if (gutters) piece.appendChild(gutterSlice(gutters, content, group, first));
    const body = content.cloneNode(false) as HTMLElement;
    for (const line of group) body.appendChild(line);
    piece.appendChild(body);
    first += group.length;
    return piece;
  });
}

/** The line-number cells CodeMirror currently has rendered, its width spacer aside. */
function numberedCells(gutters: HTMLElement | null): HTMLElement[] {
  const column = gutters?.querySelector<HTMLElement>(".cm-lineNumbers");
  if (!column) return [];
  // CodeMirror keeps one zero-height hidden cell in the column to measure its width.
  return (Array.from(column.children) as HTMLElement[]).filter((cell) => cell.offsetHeight > 0);
}

/**
 * CodeMirror's line-number gutter, rebuilt for `count` lines starting at `first`.
 *
 * The numbers are *generated*, not sliced out of the source column. CodeMirror
 * renders gutter cells for the lines it has in view, so the column is not reliably
 * one cell per line — in a tall block inside the split editor it came up a cell
 * short, and slicing by position then put every number one line out. A line's
 * number is simply its 1-based position, so it can be computed; a rendered cell is
 * cloned as the template so the column keeps CodeMirror's own styling.
 *
 * Each cell's height is then pinned to the line it labels. CodeMirror measured the
 * template in the *editor*, and the print surface sets code at a different size, so
 * keeping its height drifted the numbers a fraction of a pixel per line — half a
 * page down, a number sat nearly two lines below its own code.
 *
 * Only the line-number column is rebuilt: any other gutter is dropped rather than
 * guessed at.
 */
function gutterSlice(
  gutters: HTMLElement,
  content: HTMLElement,
  lines: HTMLElement[],
  first: number,
): HTMLElement {
  const slice = gutters.cloneNode(false) as HTMLElement;
  // CodeMirror pins the whole document's height here; a piece is only as tall as
  // the lines it holds.
  slice.style.minHeight = "";

  const column = gutters.querySelector<HTMLElement>(".cm-lineNumbers");
  const template = numberedCells(gutters)[0];
  if (!column || !template) return slice;

  const copy = column.cloneNode(false) as HTMLElement;
  const spacer = (Array.from(column.children) as HTMLElement[]).find(
    (cell) => cell.offsetHeight === 0,
  );
  if (spacer) copy.appendChild(spacer.cloneNode(true));
  lines.forEach((line, i) => {
    const cell = template.cloneNode(false) as HTMLElement;
    cell.style.height = `${line.getBoundingClientRect().height}px`;
    // CodeMirror offsets the column's first cell by the content box's top padding;
    // every piece starts a fresh column, so every piece needs that offset.
    cell.style.marginTop = i === 0 ? getComputedStyle(content).paddingTop : "";
    cell.textContent = String(first + i + 1);
    copy.appendChild(cell);
  });
  slice.appendChild(copy);
  return slice;
}

/**
 * Split a code block between source lines. The block is first rebuilt as one
 * block-level span per line so the lines can be measured and grouped.
 *
 * Rebuilding from `textContent` drops any inline syntax highlighting inside the
 * block. That only happens for a code block longer than a full page, where the
 * alternative — clipping it at the page edge — would lose the code itself.
 */
function splitPre(pre: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const code = pre.querySelector("code") ?? pre;
  const lines = (code.textContent ?? "").replace(/\n$/, "").split("\n");
  if (lines.length < 2) return [];
  const holders = lines.map((line) => {
    const span = document.createElement("span");
    span.className = CODE_LINE_CLASS;
    // A blank source line still has to occupy a line box.
    span.textContent = line === "" ? "​" : line;
    return span;
  });
  code.replaceChildren(...holders);
  const groups = packByHeight(holders, maxHeightPx);
  if (groups.length < 2) return [];
  return groups.map((group) => {
    const piece = pre.cloneNode(false) as HTMLElement;
    const codePiece = code.cloneNode(false) as HTMLElement;
    for (const line of group) codePiece.appendChild(line);
    piece.appendChild(codePiece);
    return piece;
  });
}

/**
 * Split a Markdown source line that wraps onto more lines than a page holds,
 * between its wrapped lines.
 *
 * The Markdown version prints each source line as one block, and a block taller
 * than a page was clipped at the page edge, so a long paragraph, a data URI or a
 * file of thousands of nested quotes lost everything below its first page. Each
 * piece holds whole wrapped lines of the text, so it wraps as the line did and
 * every character prints once.
 *
 * The wrapped lines are found from where the browser placed each character. A
 * character's box is its line's text box, which sits inside the line box with the
 * half-leading above and below it, so the gap above the first character measures
 * that half-leading for every line.
 */
function splitSourceLine(line: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const text = line.firstChild;
  if (!(text instanceof Text) || line.childNodes.length !== 1) return [];
  const box = line.getBoundingClientRect();
  const range = document.createRange();
  /** The text box of the character at `offset`, measured from the line's top. */
  const charBox = (offset: number): { top: number; bottom: number } => {
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const rect = range.getBoundingClientRect();
    return { top: rect.top - box.top, bottom: rect.bottom - box.top };
  };
  const leading = charBox(0).top;

  const starts = [0];
  let pageTop = 0;
  while (box.height - pageTop > maxHeightPx) {
    // The first character whose line box ends below this page starts the next
    // piece. Characters only move down as the offset grows, so search for it.
    const limit = pageTop + maxHeightPx;
    let low = starts[starts.length - 1] + 1;
    let high = text.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (charBox(middle).bottom + leading > limit) high = middle;
      else low = middle + 1;
    }
    if (low >= text.length) break;
    starts.push(low);
    pageTop = charBox(low).top - leading;
  }
  if (starts.length < 2) return [];
  return starts.map((start, index) => {
    const piece = line.cloneNode(false) as HTMLElement;
    piece.textContent = text.data.slice(start, starts[index + 1]);
    return piece;
  });
}
