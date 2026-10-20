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
// long code block, a paragraph or heading, a quote, a footnote, a Markdown
// source line that wraps past a page) are split one level down first, so the
// packer always has pieces it can place. Text splits between the lines it wraps
// onto, never inside a line, and a quote, a footnote or a list item between the
// blocks it holds, each split the same way. What cannot be split, such as an
// image taller than a page, is shrunk to fit the page rather than cut off at
// its edge.
//
// Wherever a block or a piece of one has to fit a page, the margin it takes at
// the top of the page counts: its own top margin collapsed with those of the
// first blocks inside it and of the containers around it (leadingMargin).
//
// A heading prints on the page of the block after it, or of that block's first
// piece, when the two fit a page together (packBoxes).

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
  return packByHeight(Array.from(flow.children) as HTMLElement[], contentHeightPx);
}

/**
 * Pack laid-out siblings into groups no taller than `maxHeightPx`.
 *
 * Heights come from `offsetTop`/`offsetHeight`, i.e. border boxes. The margin
 * the first block takes at the top of a page must be added back for each page
 * (leadingMargin): the page's flow is a block formatting context (`display:
 * flow-root`, app.css), so that margin is contained by (and consumes space in)
 * the page rather than collapsing outside it, and it scales with the flow.
 * `outer` holds the margins of the containers around the items that collapse
 * with the first item's, as leadingMargin describes. An element taller than
 * the limit gets a group to itself rather than an empty page before it.
 *
 * A heading goes in the group of the item after it whenever the two fit a
 * group together (packBoxes), so a page does not end with a heading whose
 * text starts on the next page.
 */
export function packByHeight<T extends HTMLElement>(items: T[], maxHeightPx: number, outer: number[] = []): T[][] {
  const boxes = items.map((el) => ({
    top: el.offsetTop,
    height: el.offsetHeight,
    marginTop: leadingMargin(el, outer),
    keepWithNext: HEADING_TAGS.has(el.tagName),
  }));
  return packBoxes(boxes, maxHeightPx).map((group) => group.map((i) => items[i]));
}

/** Headings, which print on the page of the block after them (packBoxes). */
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/** One laid-out item's vertical extent, as the packer sees it. */
interface Box {
  top: number;
  height: number;
  /**
   * The margin above the item when it starts a page (leadingMargin). Only
   * ordinary flow blocks need this; derived line boxes have no margin.
   */
  marginTop?: number;
  /** Whether the item goes on the page of the item after it, as a heading does. */
  keepWithNext?: boolean;
}

/**
 * The packing itself, over measurements rather than elements, so a caller that
 * has to *derive* an item's height can still use it — see splitCodeMirror, where
 * a source line is as tall as the taller of the text and its gutter number.
 * Returns groups of indices into `boxes`.
 *
 * Items go on the current page while they fit and start a new page when they
 * do not. A run of `keepWithNext` items, such as a heading or a heading and
 * its subheading, goes on the page with the item after the run, so a heading
 * that does not fit above the start of its text moves to the next page with
 * it, as a word processor keeps a heading with the next paragraph. A run that
 * cannot share an empty page with the item after it, such as a heading before
 * a piece of a split paragraph that fills a page, is packed item by item
 * instead, since moving it would leave a page holding nothing but the run.
 */
function packBoxes(boxes: Box[], maxHeightPx: number): number[][] {
  const pages: number[][] = [];
  let current: number[] = [];
  let origin = 0;
  for (let first = 0; first < boxes.length; ) {
    const last = keptTogether(boxes, first, maxHeightPx);
    if (!current.length || bottomOf(boxes, first, last) - origin > maxHeightPx) {
      if (current.length) pages.push(current);
      current = [];
      origin = topOf(boxes[first]);
    }
    for (let index = first; index <= last; index++) current.push(index);
    first = last + 1;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

/**
 * The last of the boxes that go on one page with `boxes[first]`: the box
 * after the run of `keepWithNext` boxes that `first` starts, when the run and
 * that box fit an empty page together, or `first` itself. A box inside a run
 * starts none, so a run that cannot move whole is packed as it always was.
 */
function keptTogether(boxes: Box[], first: number, maxHeightPx: number): number {
  if (!boxes[first].keepWithNext || boxes[first - 1]?.keepWithNext) return first;
  let next = first + 1;
  while (next < boxes.length && boxes[next].keepWithNext) next++;
  if (next === boxes.length) return first;
  return bottomOf(boxes, first, next) - topOf(boxes[first]) <= maxHeightPx ? next : first;
}

/** Where a page that starts with `box` begins: above the margin the box takes there. */
function topOf(box: Box): number {
  return box.top - (box.marginTop ?? 0);
}

/** The lowest bottom edge of boxes `first` to `last`. */
function bottomOf(boxes: Box[], first: number, last: number): number {
  let bottom = -Infinity;
  for (let index = first; index <= last; index++) {
    bottom = Math.max(bottom, boxes[index].top + boxes[index].height);
  }
  return bottom;
}

/**
 * Replace any child taller than a page with a sequence of page-sized pieces.
 * The margin a child takes at the top of a page counts (leadingMargin): a
 * page makes room for it above the child (packByHeight), so a heading that
 * fit only without its margin was left whole and the page body cut off its
 * last line.
 */
function splitOversized(flow: HTMLElement, contentHeightPx: number): void {
  // Snapshot first: the list is mutated while splitting.
  for (const child of Array.from(flow.children)) {
    const el = child as HTMLElement;
    if (leadingMargin(el) + el.offsetHeight <= contentHeightPx) continue;
    fitBlock(el, contentHeightPx);
  }
}

/**
 * Make a laid-out block taller than `maxHeightPx` fit: split it into pieces in
 * its place, then shrink whatever cannot be split (scaleToFit), the whole block
 * or a piece holding one line taller than a page, rather than let the page cut it.
 *
 * Each piece fits the page with the margin it takes at the top of one, which
 * includes the margins in `outer` (leadingMargin). Every function below that
 * splits or shrinks a block keeps to the same rule.
 */
function fitBlock(el: HTMLElement, maxHeightPx: number, outer: number[] = []): void {
  const pieces = splitBlock(el, maxHeightPx, outer);
  if (!pieces.length) {
    scaleToFit(el, maxHeightPx, outer);
    return;
  }
  el.replaceWith(...pieces);
  for (const piece of pieces) {
    if (oversized.has(piece)) scaleToFit(piece, maxHeightPx, outer);
  }
}

/**
 * Pieces that hold one unit taller than a page, so no split can make them fit:
 * a line of text, a table row, a wrapped line of code.
 */
const oversized = new WeakSet<Element>();

/** Marks a block shrunk to fit a page (scaleToFit). */
const FIT_CLASS = "print-fit";

/**
 * Shrink a block that cannot be split until it fits `maxHeightPx`, such as an
 * image taller than a page, a table with one row taller than a page, or a line
 * of text holding such an image. The page body cut off everything below its
 * edge, so the rest of the block was missing from the print.
 *
 * The block is scaled with a transform, centred, inside a frame as tall as the
 * scaled block. A transform leaves the block's own layout alone, so its text
 * wraps as before, and the frame makes the page leave room for exactly what
 * shows. The frame takes over the block's margins, and it contains the margins
 * of the block's first and last children, which would otherwise collapse past
 * it unscaled: a Mermaid diagram's panel has one, and it pushed the diagram 6px
 * past the page. A block that already fits, for instance once a child of it was
 * shrunk, is left alone.
 */
function scaleToFit(el: HTMLElement, maxHeightPx: number, outer: number[] = []): void {
  const style = getComputedStyle(el);
  const height = Math.max(el.offsetHeight, el.getBoundingClientRect().height);
  if (leadingMargin(el, outer) + height <= maxHeightPx) return;
  const frame = document.createElement("div");
  frame.className = FIT_CLASS;
  frame.style.display = "flow-root";
  frame.style.marginTop = style.marginTop;
  frame.style.marginBottom = style.marginBottom;
  el.style.marginTop = "0px";
  el.style.marginBottom = "0px";
  el.replaceWith(frame);
  frame.appendChild(el);
  // The frame takes only the block's own top margin above it.
  const room = Math.max(1, maxHeightPx - leadingMargin(frame, outer));
  // The children's margins now sit inside the frame, around the block, and
  // keep their size; only the block itself shrinks.
  const margins = Math.max(0, frame.getBoundingClientRect().height - height);
  // However small the factor: a floor of 1 percent left an image 20,000 px
  // tall reaching past the page.
  el.style.transform = `scale(${Math.max(0, (room - margins) / height)})`;
  el.style.transformOrigin = "top center";
  frame.style.height = `${room}px`;
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
 *
 * Rebuilding the wrappers keeps only the path to the split element, so a block
 * that holds more than that splits between its children instead. A Mermaid
 * code block is one: its diagram sits below the code, and splitting only the
 * code left the diagram out of every piece.
 *
 * Each piece fits `maxHeightPx` with the margin it takes at the top of a page,
 * `outer` included (leadingMargin). A quote or a list splits between its
 * children, and works that margin out for each piece from the child it starts
 * with.
 */
function splitBlock(el: HTMLElement, maxHeightPx: number, outer: number[]): HTMLElement[] {
  if (CONTAINER_TAGS.has(el.tagName)) return splitContainer(el, maxHeightPx, outer);
  if (LIST_TAGS.has(el.tagName)) return splitList(el, maxHeightPx, outer);
  const inner = splittableIn(el);
  if (!inner) return [];
  const beside = Array.from(el.children).some(
    (child) => !child.contains(inner) && (child as HTMLElement).offsetHeight > 0,
  );
  if (inner !== el && beside && holdsBlocks(el)) return splitContainer(el, maxHeightPx, outer);
  // Every piece takes the block's margin at the top of a page, and the
  // wrappers around the split element repeat their own height (padding,
  // borders, sibling chrome). Leave room for both so a piece still fits on the
  // page. Without the margin, pieces of a table or code block reached 4 px past
  // the page.
  const room = Math.max(
    1,
    maxHeightPx - leadingMargin(el, outer) - Math.max(0, el.offsetHeight - inner.offsetHeight),
  );
  const pieces = splitElement(inner, room);
  if (inner === el) return pieces;
  return pieces.map((piece) => {
    const wrapped = rewrap(el, inner, piece);
    if (oversized.has(piece)) oversized.add(wrapped);
    return wrapped;
  });
}

/**
 * Dispatch to the splitter for one element's own kind. The pieces' border
 * boxes fit `maxHeightPx`; the caller leaves room for the margin above them.
 */
function splitElement(el: HTMLElement, maxHeightPx: number): HTMLElement[] {
  if (el.classList.contains("cm-scroller")) return splitCodeMirror(el, maxHeightPx);
  if (el.classList.contains(SOURCE_LINE_CLASS)) return splitSourceLine(el, maxHeightPx);
  if (TEXT_TAGS.has(el.tagName)) return splitText(el, maxHeightPx);
  switch (el.tagName) {
    case "TABLE":
      return splitTable(el as HTMLTableElement, maxHeightPx);
    case "UL":
    case "OL":
      return splitList(el, maxHeightPx, []);
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
const TEXT_TAGS = new Set(["P", ...HEADING_TAGS]);

/**
 * Blocks that hold other blocks, split between them (splitContainer). Checked
 * before looking inside a block, so a quote around a long list or table keeps
 * the rest of its content: splitting only the list inside dropped the quote's
 * other blocks from every piece.
 *
 * Crepe renders a footnote definition as `dl > (dt, dd)`, the label in the
 * `dt` and the note's blocks in the `dd`, so a note splits between its blocks,
 * with its label on the first piece. Before both were listed here, a footnote
 * taller than a page was shrunk onto one page, to 4 percent of its size at 200%
 * scale.
 */
const CONTAINER_TAGS = new Set(["BLOCKQUOTE", "DL", "DD"]);

/** Lists, split between their items (splitList). */
const LIST_TAGS = new Set(["UL", "OL"]);

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
  // Whatever height the table has beyond its rows, such as its collapsed
  // border, every piece has too.
  const rowRoom = Math.max(1, maxHeightPx - head.heightPx - heightBeyond(table, Array.from(table.rows)));
  const groups = packByHeight(bodyRows, rowRoom);
  if (groups.length < 2) return [];

  // Rows keep the container they came from: Crepe's `<tbody>` carries attributes
  // its own styles key off, so a bare replacement would restyle the split pieces.
  // A row with no container of its own goes straight into the table.
  const parent = bodyRows[0].parentElement;
  const container = parent && parent !== table ? parent : null;

  return groups.map((rows) => {
    // Measured before the rows move into a piece that is not laid out.
    const tooTall = rows.length === 1 && rows[0].offsetHeight > rowRoom;
    const piece = table.cloneNode(false) as HTMLTableElement;
    applyFrozenColumns(piece, frozen);
    if (head.section) piece.appendChild(head.section.cloneNode(true));
    const body = container ? (container.cloneNode(false) as HTMLElement) : piece;
    if (head.row && !head.section) body.appendChild(head.row.cloneNode(true));
    for (const row of rows) body.appendChild(row);
    if (body !== piece) piece.appendChild(body);
    if (tooTall) oversized.add(piece);
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
 * Split a block that holds other blocks, such as a quote or a footnote, between
 * its children.
 *
 * A quote printed as one block, and the page body clipped one taller than a
 * page: a quote of 120 paragraphs stopped at paragraph 29. Each piece is a copy
 * of the container holding a run of its children. A child that does not fit a
 * page by itself is split first by the same rules, so a long paragraph or a
 * nested quote inside the quote continues on the next page too, and a child that
 * cannot be split, such as a tall image, is shrunk to fit.
 *
 * A term (`dt`), such as a footnote's label, stays on the page with the start of
 * the description after it: a description that does not fit a page with the
 * term above it is split to leave room for it. Its first piece filled a page,
 * so the label printed alone at the foot of the page before, and so did the
 * label of a description that fit a page only by itself.
 */
function splitContainer(container: HTMLElement, maxHeightPx: number, outer: number[]): HTMLElement[] {
  if (!holdsBlocks(container)) return [];
  const inside = insideOf(container, maxHeightPx, outer);
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const term = child.previousElementSibling as HTMLElement | null;
    // From the margin above the term to the margin above the description.
    const kept =
      term?.tagName === "DT"
        ? leadingMargin(term, inside.outer) + child.offsetTop - term.offsetTop - leadingMargin(child, inside.outer)
        : 0;
    const room = Math.max(1, inside.room - kept);
    if (leadingMargin(child, inside.outer) + child.offsetHeight <= room) continue;
    fitBlock(child, room, inside.outer);
  }
  const children = Array.from(container.children) as HTMLElement[];
  if (children.length < 2) return [];
  const groups = packByHeight(children, inside.room, inside.outer);
  if (groups.length < 2) return [];
  return groups.map((group) => {
    const piece = container.cloneNode(false) as HTMLElement;
    piece.append(...group);
    return piece;
  });
}

/**
 * The room the children of a container that splits between them have on a
 * page, and the margins above them that collapse with the margin of the child
 * a piece starts with (leadingMargin), when a piece of the container starts a
 * page. Every piece repeats the container's padding and borders. A container
 * with no top padding or border shares its top margin with its first child, as
 * a quote does with a heading or a table it begins with, so the margin counts
 * once, the larger of the two.
 */
function insideOf(container: HTMLElement, maxHeightPx: number, outer: number[]): { room: number; outer: number[] } {
  const style = getComputedStyle(container);
  const margins = [...outer, topMarginOf(style)];
  const bottom = px(style.paddingBottom) + px(style.borderBottomWidth);
  if (opensAtTop(style)) return { room: Math.max(1, maxHeightPx - bottom), outer: margins };
  const top = collapse(margins) + px(style.paddingTop) + px(style.borderTopWidth);
  return { room: Math.max(1, maxHeightPx - top - bottom), outer: [] };
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
 * (splitListItem), and its pieces are packed like items. Items sit in the list
 * as a quote's blocks sit in the quote (insideOf).
 */
function splitList(list: HTMLElement, maxHeightPx: number, outer: number[]): HTMLElement[] {
  const inside = insideOf(list, maxHeightPx, outer);
  for (const item of listItems(list)) {
    if (leadingMargin(item, inside.outer) + item.offsetHeight <= inside.room) continue;
    const pieces = splitListItem(item, inside.room, inside.outer);
    if (pieces.length) item.replaceWith(...pieces);
    else scaleToFit(item, inside.room, inside.outer);
  }
  const items = listItems(list);
  if (items.length < 2) return [];
  const groups = packByHeight(items, inside.room, inside.outer);
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
 *
 * Crepe's content sits in a flex item, which holds the margin above the
 * content's first block inside the item. Each piece of the content brings its
 * own such margin, from the block the piece starts with (splitContainer), so
 * only the rest of the item's height around the content counts as what every
 * piece repeats.
 */
function splitListItem(item: HTMLElement, maxHeightPx: number, outer: number[]): HTMLElement[] {
  const content =
    item.querySelector<HTMLElement>(":scope > li > .children > .content-dom") ??
    (item.tagName === "LI" ? item : null);
  if (!content) return [];
  let pieces: HTMLElement[];
  if (content === item) {
    pieces = splitContainer(item, maxHeightPx, outer);
  } else {
    const around = Math.max(0, item.offsetHeight - content.offsetHeight - leadingMargin(content));
    pieces = splitContainer(content, Math.max(1, maxHeightPx - leadingMargin(item, outer) - around), []);
  }
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
  // Whatever height the block has beyond its lines, such as its padding, every
  // piece has too, as in splitCodeMirror. Packing the lines alone let a piece
  // of Crepe's placeholder for a code block CodeMirror has not drawn yet reach
  // past the page by its 8 px of padding.
  const room = Math.max(1, maxHeightPx - heightBeyond(pre, holders));
  const groups = packByHeight(holders, room);
  if (groups.length < 2) return [];
  return groups.map((group) => {
    // A line that wraps past a page, which the unrendered code block can show.
    // Measured before the line moves into a piece that is not laid out.
    const tooTall = group.length === 1 && group[0].offsetHeight > room;
    const piece = pre.cloneNode(false) as HTMLElement;
    const codePiece = code.cloneNode(false) as HTMLElement;
    for (const line of group) codePiece.appendChild(line);
    piece.appendChild(codePiece);
    if (tooTall) oversized.add(piece);
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
 * Where the wrapped lines start is read from the laid-out block: the first unit
 * of a line sits a line lower than the characters of the line before it, in
 * left-to-right and right-to-left text alike. A trial copy of each piece, laid
 * out where the block is, then confirms that the piece fits, so the break is
 * exact even where a line holds inline code, math or an image taller than the
 * text.
 *
 * The pieces are cut out of the block with a DOM range. It moves whole nodes and
 * splits an element that spans a break, such as bold text or a link, into two
 * copies with the same attributes, so the formatting carries over to the next
 * page. An element laid out as one box (inline code, math, an image) is never
 * cut, and every character lands in exactly one piece. A line taller than a
 * page, which an image in it can make, gets a piece of its own that is marked
 * `oversized` for the caller to shrink.
 */
function splitText(block: HTMLElement, maxHeightPx: number): HTMLElement[] {
  const run = inlineRun(block);
  const end = run.length;
  if (end < 2) return [];
  // The caller has left room for the margin above the block (splitBlock).
  const budget = maxHeightPx;
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
  /**
   * Whether unit `index` is a character. A hard break counts as one, because
   * it measures as the text box of the line it ends.
   */
  const isCharacter = (index: number): boolean => {
    const { item } = locate(index);
    return item instanceof Text || item.tagName === "BR";
  };
  const rtl = getComputedStyle(block).direction === "rtl";
  /**
   * Whether `later`, a unit after `earlier`, sits on a later line.
   *
   * When either is a character, it does when its top and its bottom are both
   * lower by more than half the smaller unit. Characters on one line share its
   * baseline, and a box among them, such as an image, inline code or math, sits
   * on the baseline or on the bottom of the line, so nothing on one line sits
   * that much lower than anything else on it, not even a superscript or a small
   * image. Which way the unit moved across the line does not matter. md-easy
   * sets no text direction, so Chromium lays a Hebrew or Arabic paragraph out
   * left to right with each line one right-to-left run, and a line starts at
   * the right end of the run. Judged by direction, as two boxes are below, such
   * a paragraph had no line breaks at all and was shrunk onto one page.
   *
   * Between two boxes the bottom says less, since either can be the tallest on
   * its line. There `later` starts a line when it moved down and back towards
   * the start of the line, or sits wholly below `earlier` without moving
   * forward.
   */
  const onLaterLine = (earlier: DOMRect, later: DOMRect, character: boolean): boolean => {
    const half = Math.min(earlier.height, later.height) / 2;
    const lower = later.top - earlier.top > half && later.bottom - earlier.bottom > half;
    if (character) return lower;
    const back = rtl ? later.right > earlier.right + 0.5 : later.left < earlier.left - 0.5;
    const forward = rtl ? later.right < earlier.right - 0.5 : later.left > earlier.left + 0.5;
    return (lower && back) || (later.top >= earlier.bottom - 0.5 && !forward);
  };
  /**
   * The first unit of the line that holds unit `index`. Once a character of
   * that line is found, the units before it are compared with that character,
   * so that a box is compared with a character wherever the line has one.
   */
  const lineStart = (index: number): number => {
    let next = box(index);
    let start = index;
    let anchor = hasBox(next) && isCharacter(index) ? next : null;
    for (let i = index - 1; i >= 0; i--) {
      const previous = box(i);
      if (!hasBox(previous)) continue;
      const character = isCharacter(i);
      if (hasBox(next) && onLaterLine(previous, anchor ?? next, character || anchor !== null)) return start;
      next = previous;
      start = i;
      if (character) anchor = previous;
    }
    return 0;
  };
  /**
   * The first unit of the line after the one that holds unit `index`, or `end`.
   * Once a character of the line is found, the units after it are compared
   * with that character, as in lineStart.
   */
  const nextLineStart = (index: number): number => {
    let previous = box(index);
    let anchor = hasBox(previous) && isCharacter(index) ? previous : null;
    for (let i = index + 1; i < end; i++) {
      const next = box(i);
      if (!hasBox(next)) continue;
      const character = isCharacter(i);
      if (hasBox(previous) && onLaterLine(anchor ?? previous, next, character || anchor !== null)) return i;
      previous = next;
      if (character) anchor = next;
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
  /**
   * Whether units [from, to) fit the page, laid out as the piece will be.
   *
   * A range copies only what lies inside the node that holds both its ends,
   * so a piece wholly inside bold text or a link came out without it, and was
   * measured in plain text. Where bold text is wider, the cut piece then ran
   * past the page. The copy is wrapped in copies of the elements around it, up
   * to the block, as the cut piece is.
   */
  const fits = (from: number, to: number): boolean => {
    const start = pointBefore(from);
    const stop = pointBefore(to);
    range.setStart(start.node, start.offset);
    range.setEnd(stop.node, stop.offset);
    let content: Node = range.cloneContents();
    for (let level = range.commonAncestorContainer; level !== block; level = level.parentNode!) {
      if (!(level instanceof Element)) continue;
      const copy = level.cloneNode(false);
      copy.appendChild(content);
      content = copy;
    }
    const probe = block.cloneNode(false) as HTMLElement;
    probe.appendChild(content);
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
  /** Pieces that hold one line taller than the page, by their first unit. */
  const tooTall = new Set<number>();
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
      // A line taller than the page gets a piece of its own, shrunk to fit later.
      if (previous <= start) {
        tooTall.add(start);
        break;
      }
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
    if (tooTall.has(starts[i])) oversized.add(piece);
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

/**
 * How much taller `el` is than the run of `units` it stacks, such as its
 * padding and borders. Read from the laid-out boxes, since summing rounded
 * heights of many units can come out taller than the element.
 */
function heightBeyond(el: Element, units: Element[]): number {
  if (!units.length) return 0;
  const run = units[units.length - 1].getBoundingClientRect().bottom - units[0].getBoundingClientRect().top;
  return Math.max(0, el.getBoundingClientRect().height - run);
}

/**
 * The margin above `el` when it starts a page: its top margin collapsed with
 * the top margins of the first blocks inside it that adjoin it, and with
 * `outer`, the margins of the containers around it that share its top edge on
 * the page (insideOf).
 *
 * A page's flow holds that margin (`flow-root`, app.css), and every place that
 * leaves room for the margin above a block or a piece of one uses this. A
 * quote that begins with a heading takes the heading's 28 px margin, not its
 * own 4 px, since the two collapse into one above the quote. Leaving room for
 * 4 px let a quote that filled a page run up to 24 px past it. A table block
 * in a quote shares its 4 px margin with the quote's, and counting both left
 * each piece of the table a row short.
 */
function leadingMargin(el: Element, outer: number[] = []): number {
  const margins = [...outer];
  for (let box: Element | null = el; box; box = firstInFlowChild(box)) {
    const style = getComputedStyle(box);
    margins.push(topMarginOf(style));
    if (!opensAtTop(style)) break;
  }
  return collapse(margins);
}

/** Adjoining margins as the one they collapse into: the largest plus the most negative. */
function collapse(margins: number[]): number {
  return Math.max(0, ...margins) + Math.min(0, ...margins);
}

/** A box's top margin. Table rows, cells and the like have none. */
function topMarginOf(style: CSSStyleDeclaration): number {
  return style.display.startsWith("table-") && style.display !== "table-caption" ? 0 : px(style.marginTop);
}

/**
 * Whether a box's top margin adjoins the top margin of its first child, so
 * the two collapse. It does for a box of ordinary block layout with no top
 * padding or border that starts no formatting context of its own. A flex
 * container such as Crepe's list item, a table, a `flow-root` or a box that
 * clips its overflow holds its children's margins inside it.
 */
function opensAtTop(style: CSSStyleDeclaration): boolean {
  return (
    FLOW_LAYOUTS.has(style.display) &&
    !px(style.paddingTop) &&
    !px(style.borderTopWidth) &&
    UNCLIPPED.has(style.overflowX) &&
    UNCLIPPED.has(style.overflowY) &&
    (!style.float || style.float === "none") &&
    !OUT_OF_FLOW.has(style.position) &&
    !/layout|paint|content|strict/.test(style.contain)
  );
}

const FLOW_LAYOUTS = new Set(["block", "list-item"]);

/** Overflow values that start no formatting context. */
const UNCLIPPED = new Set(["visible", "clip"]);

/**
 * The first child laid out in the flow of `box`, when it is a block. Text or
 * an inline box before any block starts a line, which keeps the margins
 * apart. Hidden, floated and positioned children take no part.
 */
function firstInFlowChild(box: Element): Element | null {
  for (let node = box.firstChild; node; node = node.nextSibling) {
    if (node instanceof Text) {
      if (node.data.trim()) return null;
      continue;
    }
    if (!(node instanceof Element)) continue;
    const style = getComputedStyle(node);
    if (style.display === "none" || OUT_OF_FLOW.has(style.position)) continue;
    if (style.float && style.float !== "none") continue;
    return BLOCK_LEVEL.has(style.display) ? node : null;
  }
  return null;
}

const BLOCK_LEVEL = new Set(["block", "list-item", "flow-root", "flex", "grid", "table"]);

/** A computed length in px; 0 for one that is not a number, such as `medium`. */
function px(value: string): number {
  return Number.parseFloat(value) || 0;
}
