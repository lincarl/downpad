// Block-level pagination for the custom print path (spec §5.21).
//
// The document is laid out once, at the exact content width of a page, and its
// top-level blocks are then packed into page-sized groups. Breaks fall between
// blocks, or between the lines of a block taller than a page, so a printed page
// never cuts a line of text in half the way a naive fixed-height clip would. This
// is what makes the output read like a document rather than a screenshot of a
// scrolling page.
//
// Blocks that are themselves taller than a page (a long table, a long list, a
// long code block, a paragraph or heading, a quote, a Markdown source line that
// wraps past a page) are split one level down first, so the packer always has
// pieces it can place. Text splits between the lines it wraps onto, never inside
// a line, and a quote or a list item between the blocks it holds, each split the
// same way.

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
    return { top: el.offsetTop, height: el.offsetHeight, marginTop: marginTopOf(el) };
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
  if (TEXT_TAGS.has(el.tagName)) return splitText(el, maxHeightPx);
  if (CONTAINER_TAGS.has(el.tagName)) return splitContainer(el, maxHeightPx);
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
  if (
    SPLITTABLE_TAGS.has(block.tagName) ||
    TEXT_TAGS.has(block.tagName) ||
    CONTAINER_TAGS.has(block.tagName) ||
    block.classList.contains(SOURCE_LINE_CLASS)
  ) {
    return block;
  }
  let tallest: HTMLElement | null = null;
  for (const el of block.querySelectorAll<HTMLElement>(SPLITTABLE_SELECTOR)) {
    if (!tallest || el.offsetHeight > tallest.offsetHeight) tallest = el;
  }
  return tallest;
}

const SPLITTABLE_TAGS = new Set(["TABLE", "UL", "OL", "PRE"]);

/** Blocks of inline content, split between the lines they wrap onto (splitText). */
const TEXT_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Blocks that hold other blocks, split between them (splitContainer). Checked
 * before looking inside a block, so a quote around a long list or table keeps
 * the rest of its content: splitting only the list inside dropped the quote's
 * other blocks from every piece.
 */
const CONTAINER_TAGS = new Set(["BLOCKQUOTE"]);

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
 * Split a block that holds other blocks, such as a quote, between its children.
 *
 * A quote printed as one block, and the page body clipped one taller than a
 * page: a quote of 120 paragraphs stopped at paragraph 29. Each piece is a copy
 * of the container holding a run of its children. A child that does not fit a
 * page by itself is split first by the same rules, so a long paragraph or a
 * nested quote inside the quote continues on the next page too.
 */
function splitContainer(container: HTMLElement, maxHeightPx: number): HTMLElement[] {
  if (!holdsBlocks(container)) return [];
  const style = getComputedStyle(container);
  // Every piece repeats the container's top margin, padding and borders.
  const chrome =
    marginTopOf(container) +
    (Number.parseFloat(style.paddingTop) || 0) +
    (Number.parseFloat(style.paddingBottom) || 0) +
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0);
  const room = Math.max(1, maxHeightPx - chrome);
  for (const child of Array.from(container.children) as HTMLElement[]) {
    if (child.offsetHeight + marginTopOf(child) <= room) continue;
    const pieces = splitBlock(child, room);
    if (pieces.length) child.replaceWith(...pieces);
  }
  const children = Array.from(container.children);
  if (children.length < 2) return [];
  const groups = packByHeight(children, room);
  if (groups.length < 2) return [];
  return groups.map((group) => {
    const piece = container.cloneNode(false) as HTMLElement;
    piece.append(...group);
    return piece;
  });
}

/**
 * Whether `el` holds only elements, so splitting between them moves all of its
 * content. Text directly inside it would be left behind.
 */
function holdsBlocks(el: HTMLElement): boolean {
  return Array.from(el.childNodes).every(
    (node) => node instanceof Element || node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim(),
  );
}

/**
 * Split a list between items, continuing the numbering on ordered lists.
 *
 * An item is not always an `<li>`: Crepe renders each one as
 * `<ul><div class="milkdown-list-item-block"><li>…`, so matching only `LI`
 * children found nothing and left a long list to be clipped at the page edge.
 * Crepe draws its own bullets and numbers into those wrappers, so the numbering
 * travels with the items; `start` still carries it for plain HTML lists.
 *
 * An item taller than a page is split between its own blocks first
 * (splitListItem), and its pieces are packed like items.
 */
function splitList(list: HTMLElement, maxHeightPx: number): HTMLElement[] {
  for (const item of listItems(list)) {
    if (item.offsetHeight <= maxHeightPx) continue;
    const pieces = splitListItem(item, maxHeightPx);
    if (pieces.length) item.replaceWith(...pieces);
  }
  const items = listItems(list);
  if (items.length < 2) return [];
  const groups = packByHeight(items, maxHeightPx);
  if (groups.length < 2) return [];
  // An item's number, which the piece of it that continues on a later page keeps.
  const numbers = new Map<Element, number>();
  let number = (Number((list as HTMLOListElement).start) || 1) - 1;
  for (const item of items) {
    if (!continued.has(item)) number++;
    numbers.set(item, number);
  }
  return groups.map((group) => {
    const piece = list.cloneNode(false) as HTMLElement;
    if (list.tagName === "OL") (piece as HTMLOListElement).start = numbers.get(group[0]) ?? 1;
    for (const item of group) piece.appendChild(item);
    return piece;
  });
}

/** A list's items, in Crepe's item wrappers or plain `<li>`s. */
function listItems(list: HTMLElement): HTMLElement[] {
  return (Array.from(list.children) as HTMLElement[]).filter(
    (c) => c.tagName === "LI" || c.querySelector("li") !== null,
  );
}

/** The pieces of split list items after the first: the rest of an item, not a new one. */
const continued = new WeakSet<Element>();

/**
 * Split a list item taller than a page between the blocks it holds.
 *
 * An item printed as one block, so the page body clipped an item taller than a
 * page, such as a long paragraph under a bullet, and everything after its first
 * page was lost. Crepe renders an item as `div.milkdown-list-item-block > li >
 * (div.label-wrapper, div.children > div.content-dom)`, the bullet or number
 * beside the content. The content splits like a quote (splitContainer), and
 * each piece is rebuilt in copies of the item's wrappers. The label goes beside
 * every piece so the text keeps its indent, but only the first piece shows it:
 * the rest continue the item rather than start new ones. A plain `<li>` that
 * holds blocks splits the same way and hides its marker on later pieces.
 */
function splitListItem(item: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const content =
    item.querySelector<HTMLElement>(":scope > li > .children > .content-dom") ??
    (item.tagName === "LI" ? item : null);
  if (!content) return [];
  const overhead = Math.max(0, item.offsetHeight - content.offsetHeight);
  const pieces = splitContainer(content, Math.max(1, maxHeightPx - overhead));
  return pieces.map((piece, index) => {
    const later = index > 0;
    let wrapped = piece;
    for (
      let level = content.parentElement;
      content !== item && level && level !== item.parentElement;
      level = level.parentElement
    ) {
      const copy = level.cloneNode(false) as HTMLElement;
      for (const child of Array.from(level.children) as HTMLElement[]) {
        if (child.contains(content)) {
          copy.appendChild(wrapped);
          continue;
        }
        const beside = child.cloneNode(true) as HTMLElement;
        if (later) beside.style.visibility = "hidden";
        copy.appendChild(beside);
      }
      wrapped = copy;
    }
    if (later) {
      if (wrapped.tagName === "LI") wrapped.style.listStyleType = "none";
      continued.add(wrapped);
    }
    return wrapped;
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

/**
 * Split a paragraph or heading taller than a page between the lines it wraps
 * onto, keeping its inline formatting whole on both sides of each break.
 *
 * The Document version printed such a block as one piece, and the page body
 * clipped it, so a 9,000-word paragraph printed its first page and nothing more.
 * Where the wrapped lines start is read from the laid-out block: units on one
 * line overlap vertically, and the first unit of a line sits lower and back at
 * the start of the line. A trial copy of each piece, laid out where the block
 * is, then confirms that the piece fits, so the break is exact even where a line
 * holds inline code, math or an image taller than the text.
 *
 * The pieces are cut out of the block with a DOM range. It moves whole nodes and
 * splits an element that spans a break, such as bold text or a link, into two
 * copies with the same attributes, so the formatting carries over to the next
 * page. An element laid out as one box (inline code, math, an image) is never
 * cut, and every character lands in exactly one piece.
 */
function splitText(block: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const run = inlineRun(block);
  const end = run.length;
  if (end < 2) return [];
  const budget = Math.max(1, maxHeightPx - marginTopOf(block));
  const range = document.createRange();

  /** The text node or element holding unit `index`, and the unit's offset in it. */
  const locate = (index: number): { item: Text | Element; offset: number } => {
    let low = 0;
    let high = run.items.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (run.starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return { item: run.items[low], offset: index - run.starts[low] };
  };
  /** The box unit `index` was laid out in; empty for a character without one. */
  const box = (index: number): DOMRect => {
    const { item, offset } = locate(index);
    if (!(item instanceof Text)) return item.getBoundingClientRect();
    range.setStart(item, offset);
    range.setEnd(item, offset + 1);
    return range.getBoundingClientRect();
  };
  const rtl = getComputedStyle(block).direction === "rtl";
  /**
   * Whether `next`, the unit after `previous`, starts a wrapped line. It does
   * when it moved down by more than half a unit and back towards the start of
   * the line, or when it sits wholly below `previous` without moving forward.
   * Units on one line share a baseline, so neither holds for them, not even for
   * a superscript, a small image on the bottom of the line or a right-to-left
   * run inside a left-to-right line.
   */
  const startsLine = (previous: DOMRect, next: DOMRect): boolean => {
    const back = rtl ? next.right > previous.right + 0.5 : next.left < previous.left - 0.5;
    const forward = rtl ? next.right < previous.right - 0.5 : next.left > previous.left + 0.5;
    const lower = next.top - previous.top > Math.min(previous.height, next.height) / 2;
    return (lower && back) || (next.top >= previous.bottom - 0.5 && !forward);
  };
  /** The first unit of the line that holds unit `index`. */
  const lineStart = (index: number): number => {
    let next = box(index);
    let start = index;
    for (let i = index - 1; i >= 0; i--) {
      const previous = box(i);
      if (!hasBox(previous)) continue;
      if (hasBox(next) && startsLine(previous, next)) return start;
      next = previous;
      start = i;
    }
    return 0;
  };
  /** The first unit of the line after the one that holds unit `index`, or `end`. */
  const nextLineStart = (index: number): number => {
    let previous = box(index);
    for (let i = index + 1; i < end; i++) {
      const next = box(i);
      if (!hasBox(next)) continue;
      if (hasBox(previous) && startsLine(previous, next)) return i;
      previous = next;
    }
    return end;
  };
  /**
   * The DOM position just before unit `index`, moved out of the elements that
   * start there so a piece doesn't end with empty copies of them. A position
   * inside a text node moves back to the start of its grapheme cluster, so a
   * character made of several code units is never cut.
   */
  const pointBefore = (index: number): { node: Node; offset: number } => {
    if (index === 0) return { node: block, offset: 0 };
    if (index === end) return { node: block, offset: block.childNodes.length };
    const { item, offset } = locate(index);
    let node: Node = item;
    let at = item instanceof Text ? graphemeStart(item.data, offset) : 0;
    while (at === 0 && node !== block && node.parentNode) {
      at = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      node = node.parentNode;
    }
    return { node, offset: at };
  };
  /** Whether units [from, to) fit the page, laid out as the piece will be. */
  const fits = (from: number, to: number): boolean => {
    const start = pointBefore(from);
    const stop = pointBefore(to);
    range.setStart(start.node, start.offset);
    range.setEnd(stop.node, stop.offset);
    const probe = block.cloneNode(false) as HTMLElement;
    probe.appendChild(range.cloneContents());
    block.before(probe);
    const height = probe.offsetHeight;
    probe.remove();
    return height <= budget;
  };

  let first = 0;
  while (first < end - 1 && !hasBox(box(first))) first++;
  let last = end - 1;
  while (last > 0 && !hasBox(box(last))) last--;
  const outer = block.getBoundingClientRect();
  // The room above the first line's text and below the last line's: the block's
  // padding and the lines' half-leading. It turns a unit's box into its line's.
  const above = box(first).top - outer.top;
  const below = outer.bottom - box(last).bottom;

  const starts = [0];
  for (let start = 0; ; ) {
    const top = start === 0 ? outer.top : box(start).top - above;
    const limit = top + budget;
    let cut = end;
    if (outer.bottom - top > budget + 1) {
      // The first unit whose line ends below the page, give or take a line.
      // Units on later lines sit lower, so search for it.
      let low = start + 1;
      let high = end;
      while (low < high) {
        const middle = (low + high) >> 1;
        const unit = box(middle);
        if (hasBox(unit) && unit.bottom + below > limit) high = middle;
        else low = middle + 1;
      }
      cut = lineStart(Math.min(low, end - 1));
      if (cut <= start) cut = nextLineStart(start);
    }
    // Confirm the estimate: step back a line at a time until the piece fits,
    // then forward while one more line still fits.
    let tooFar = end + 1;
    let fitted = fits(start, cut);
    while (!fitted) {
      const previous = lineStart(cut - 1);
      // A single line taller than the page still gets a piece of its own.
      if (previous <= start) break;
      tooFar = cut;
      cut = previous;
      fitted = fits(start, cut);
    }
    while (fitted && cut < end) {
      const next = nextLineStart(cut);
      if (next >= tooFar || !fits(start, next)) break;
      cut = next;
    }
    if (cut >= end) break;
    starts.push(cut);
    start = cut;
  }
  if (starts.length < 2) return [];

  // Cut from the end, so the positions of the earlier breaks stay valid.
  const points = starts.map(pointBefore);
  const pieces: HTMLElement[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    range.setStart(points[i].node, points[i].offset);
    range.setEnd(block, block.childNodes.length);
    const piece = block.cloneNode(false) as HTMLElement;
    piece.appendChild(range.extractContents());
    pieces.unshift(piece);
  }
  return pieces;
}

/** A text block's content as one run of units a line can start at. */
interface InlineRun {
  /** Text nodes and elements laid out as one box, in document order. */
  items: (Text | Element)[];
  /** Each item's first unit: a text node has one unit per code unit of its text. */
  starts: number[];
  /** Units in the run. */
  length: number;
}

/**
 * Collect the units of a text block. Plain inline elements (bold, links, a
 * link's printed URL) are looked through. Anything else is one unit: replaced
 * content such as images, and boxes such as Crepe's inline code and math, which
 * are inline blocks. Content that takes no part in the lines, hidden or
 * positioned out of the flow, is skipped and goes with the piece around it.
 */
function inlineRun(block: HTMLElement): InlineRun {
  const items: (Text | Element)[] = [];
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Text) {
        if (child.data) items.push(child);
        continue;
      }
      if (!(child instanceof Element)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || OUT_OF_FLOW.has(style.position)) continue;
      if (style.float && style.float !== "none") continue;
      const plain =
        style.display === "inline" && !ATOMIC_TAGS.has(child.tagName) && !child.classList.contains("katex");
      if (plain) walk(child);
      else items.push(child);
    }
  };
  walk(block);
  const starts: number[] = [];
  let length = 0;
  for (const item of items) {
    starts.push(length);
    length += item instanceof Text ? item.data.length : 1;
  }
  return { items, starts, length };
}

/** Elements printed as one box even when laid out inline: replaced content and line breaks. */
const ATOMIC_TAGS = new Set([
  "IMG",
  "BR",
  "svg",
  "math",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "INPUT",
  "BUTTON",
  "SELECT",
  "TEXTAREA",
]);

const OUT_OF_FLOW = new Set(["absolute", "fixed"]);

/** Whether a measured box exists: a character with no glyph measures empty. */
function hasBox(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The start of the grapheme cluster that holds `offset` in `text`. */
function graphemeStart(text: string, offset: number): number {
  return graphemes.segment(text).containing(offset)?.index ?? offset;
}

/** An element's top margin, which a page has to make room for above it. */
function marginTopOf(el: Element): number {
  return Number.parseFloat(getComputedStyle(el).marginTop) || 0;
}
