// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { packByHeight, splitIntoPages } from "./paginate";

/** jsdom does no layout, so the measurements the packer reads are stubbed. */
function block(top: number, height: number, label: string, marginTop = 0, tag = "div"): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.label = label;
  el.style.marginTop = `${marginTop}px`;
  Object.defineProperty(el, "offsetTop", { value: top });
  Object.defineProperty(el, "offsetHeight", { value: height });
  return el;
}

const labels = (pages: Element[][]): string[][] =>
  pages.map((page) => page.map((el) => (el as HTMLElement).dataset.label!));

describe("packByHeight", () => {
  it("fills a page and breaks before the block that would overflow it", () => {
    const blocks = [block(0, 100, "a"), block(110, 100, "b"), block(220, 100, "c")];
    // a ends at 100, b at 210 (both within 250); c would end at 320.
    expect(labels(packByHeight(blocks, 250))).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps everything on one page when it all fits", () => {
    const blocks = [block(0, 100, "a"), block(110, 100, "b"), block(220, 100, "c")];
    expect(labels(packByHeight(blocks, 1000))).toEqual([["a", "b", "c"]]);
  });

  it("measures each page from its own first block, not the top of the flow", () => {
    // Without resetting the origin at a break, "c" (ending 660 from the top)
    // would look far too tall for a 200px page and land on a page of its own.
    const blocks = [block(0, 100, "a"), block(500, 100, "b"), block(560, 100, "c")];
    expect(labels(packByHeight(blocks, 200))).toEqual([["a"], ["b", "c"]]);
  });

  it("gives a block taller than a page a page of its own rather than an empty one", () => {
    const blocks = [block(0, 100, "a"), block(110, 900, "tall"), block(1020, 50, "z")];
    expect(labels(packByHeight(blocks, 300))).toEqual([["a"], ["tall"], ["z"]]);
  });

  it("returns a single empty page for empty input", () => {
    expect(packByHeight([], 500)).toEqual([[]]);
  });

  it("counts the block's own height, not the gap after it", () => {
    // "b" ends exactly at the limit; a packer that measured to the *next* block's
    // top (300) instead of b's bottom (250) would wrongly push it to page 2.
    const blocks = [block(0, 100, "a"), block(150, 100, "b"), block(300, 100, "c")];
    expect(labels(packByHeight(blocks, 250))).toEqual([["a", "b"], ["c"]]);
  });

  it("reserves the first block's top margin inside each page", () => {
    const blocks = [block(20, 180, "a", 20), block(220, 70, "heading", 20)];
    // The heading's border box would appear to fit in a 70px remainder if its
    // leading margin were discarded. The printed body contains that margin, so
    // it needs a new page instead of being clipped by the footer boundary.
    expect(labels(packByHeight(blocks, 200))).toEqual([["a"], ["heading"]]);
  });

  /**
   * A 175 px quote on the second page, with a heading inside that has a 28 px
   * top margin, and a 10 px block after it. `css` styles the quote, and
   * `before` is put in it ahead of the heading.
   */
  function quoteOnSecondPage(css = "", before?: Node): HTMLElement[] {
    const quote = block(218, 175, "quote", 4);
    quote.style.cssText += css;
    const heading = document.createElement("h2");
    heading.style.marginTop = "28px";
    if (before) quote.append(before);
    quote.append(heading);
    return [block(0, 190, "a"), quote, block(393, 10, "b")];
  }

  it("reserves the margin of a heading that begins a quote, which collapses with the quote's", () => {
    // The heading's 28 px margin and the quote's 4 px collapse into one 28 px
    // margin above the quote, so a page that starts with the quote holds 28 px
    // above it. Leaving room for only the quote's 4 px put "b" on its page, and
    // the page body cut off the end of it.
    expect(labels(packByHeight(quoteOnSecondPage(), 200))).toEqual([["a"], ["quote"], ["b"]]);
  });

  it.each([
    ["top padding", "padding-top: 1px", undefined],
    ["a top border", "border-top: 1px solid", undefined],
    ["a flex layout", "display: flex", undefined],
    ["a flow-root", "display: flow-root", undefined],
    ["clipped overflow", "overflow-y: hidden", undefined],
    ["text before the heading", "", () => document.createTextNode("Note")],
    ["an inline box before the heading", "", () => document.createElement("span")],
  ])("keeps the heading's margin inside a quote with %s, and reserves only the quote's", (_kind, css, before) => {
    // The margins do not collapse, so the heading's margin is part of the
    // quote's height and the page holds only the quote's own above it.
    expect(labels(packByHeight(quoteOnSecondPage(css, before?.()), 200))).toEqual([["a"], ["quote", "b"]]);
  });
});

describe("packByHeight, keeping a heading with the block after it", () => {
  /** A heading measured like `block`. */
  const heading = (top: number, height: number, label: string, marginTop = 0): HTMLElement =>
    block(top, height, label, marginTop, "h2");
  /** An empty paragraph or a rule, measured like `block`. */
  const blank = (top: number, height: number, label: string, tag: "p" | "hr" = "p"): HTMLElement =>
    block(top, height, label, 0, tag);
  /** A paragraph measured like `block` that holds nothing but a `child` element, such as an image. */
  const holding = (child: string, top: number, height: number, label: string): HTMLElement => {
    const paragraph = block(top, height, label, 0, "p");
    paragraph.append(document.createElement(child));
    return paragraph;
  };

  it.each([
    ["a heading that would end a page", () => [block(0, 150, "a"), heading(160, 30, "h"), block(200, 100, "b")], [["a"], ["h", "b"]]],
    [
      "a heading and its subheading that would end a page",
      () => [block(0, 150, "a"), heading(160, 20, "h1"), heading(185, 20, "h2"), block(210, 100, "b")],
      [["a"], ["h1", "h2", "b"]],
    ],
    // Only the first heading fits above the break, so the packer put the
    // subheading with the text and left the heading alone at the foot.
    [
      "a heading at the foot of a page whose subheading starts the next",
      () => [block(0, 200, "a"), heading(205, 20, "h1"), heading(230, 30, "h2"), block(265, 100, "b")],
      [["a"], ["h1", "h2", "b"]],
    ],
  ])("moves %s to the next page, with the block after it", (_kind, items, pages) => {
    // The packer measured height only, so a heading that fit printed alone at
    // the foot of the page and its text started the next page.
    expect(labels(packByHeight(items(), 250))).toEqual(pages);
  });

  it.each([
    ["an empty paragraph", () => [block(0, 150, "a"), heading(160, 30, "h"), blank(195, 8, "empty"), block(210, 100, "b")], [["a"], ["h", "empty", "b"]]],
    ["a paragraph holding only a line break", () => [block(0, 150, "a"), heading(160, 30, "h"), holding("br", 195, 8, "break"), block(210, 100, "b")], [["a"], ["h", "break", "b"]]],
    ["a rule", () => [block(0, 150, "a"), heading(160, 30, "h"), blank(195, 10, "rule", "hr"), block(215, 100, "b")], [["a"], ["h", "rule", "b"]]],
    [
      "an empty paragraph and a subheading",
      () => [block(0, 140, "a"), heading(150, 20, "h1"), blank(175, 8, "empty"), heading(190, 20, "h2"), block(215, 100, "b")],
      [["a"], ["h1", "empty", "h2", "b"]],
    ],
  ])("moves a heading with %s under it to the next page, with the block after them", (_kind, items, pages) => {
    // The heading went with the empty paragraph or rule under it, and nothing
    // more, so it stayed at the foot of the page and its text started the next.
    expect(labels(packByHeight(items(), 250))).toEqual(pages);
  });

  it.each([
    ["a rule", "hr"],
    ["an empty paragraph", "p"],
  ] as const)("packs %s with no heading above it as before", (_kind, tag) => {
    // Only a heading starts a run, so a document without headings breaks as it did.
    const items = [block(0, 200, "a"), blank(210, 10, "blank", tag), block(225, 100, "b")];
    expect(labels(packByHeight(items, 250))).toEqual([["a", "blank"], ["b"]]);
  });

  it.each([
    // A heading moved without its block would print alone on a page.
    ["the block after it is too tall to share an empty page", () => [block(0, 100, "a"), heading(110, 30, "h"), block(150, 240, "tall")], [["a", "h"], ["tall"]]],
    // Only the subheading and the block fit an empty page together. Moving the
    // subheading alone would leave the heading at the foot of the page.
    [
      "only the last heading of a run fits an empty page with the block",
      () => [block(0, 100, "a"), heading(110, 30, "h1"), heading(150, 30, "h2"), block(190, 200, "tall")],
      [["a", "h1", "h2"], ["tall"]],
    ],
    // The page leaves room for the heading's top margin above it, so the two
    // fit only without it.
    ["they fit an empty page only without the heading's top margin", () => [block(0, 90, "a"), heading(120, 30, "h", 30), block(160, 200, "b")], [["a", "h"], ["b"]]],
    // The empty paragraph does not end the run, so the subheading after it
    // starts none of its own.
    [
      "only the last heading of a run with an empty paragraph in it fits an empty page with the block",
      () => [block(0, 100, "a"), heading(110, 30, "h1"), blank(145, 8, "empty"), heading(160, 30, "h2"), block(200, 200, "tall")],
      [["a", "h1", "empty", "h2"], ["tall"]],
    ],
    // An image is what the heading introduces, not a blank to move past.
    [
      "the block after it holds only an image",
      () => [block(0, 150, "a"), heading(160, 30, "h"), holding("img", 195, 40, "image"), block(240, 100, "b")],
      [["a", "h", "image"], ["b"]],
    ],
    ["no block follows the heading", () => [block(0, 240, "a"), heading(245, 30, "h")], [["a"], ["h"]]],
    ["only an empty paragraph follows the heading", () => [block(0, 230, "a"), heading(235, 10, "h"), blank(248, 8, "empty")], [["a", "h"], ["empty"]]],
  ])("packs a heading as before when %s", (_kind, items, pages) => {
    expect(labels(packByHeight(items(), 250))).toEqual(pages);
  });
});

type HeaderShape = "crepe" | "thead" | "attribute-only" | "none";

interface TableOptions {
  /**
   * How the table expresses its header row:
   * - `crepe`  — every row in one `<tbody>`, header marked `data-is-header` (what
   *              Milkdown/Crepe renders, so what actually gets printed)
   * - `thead`  — a real `<thead>` section (pasted HTML)
   * - `attribute-only` — `data-is-header` on a row of plain `<td>`, so only Crepe's
   *              own marker identifies it
   * - `none`   — no header row at all
   */
  shape?: HeaderShape;
  /** colSpan on the first header cell, to exercise the merged-cell guard. */
  headColSpan?: number;
  /** A body row that is 900px tall rather than 100px. */
  tallRow?: number;
  /** Px the table is taller than its rows, as a collapsed border makes it. */
  border?: number;
}

/**
 * A two-column table with `count` body rows, measured as if laid out: the header
 * 40px tall, each body row 100px, the columns 120/300px inside a 420px table.
 * Body rows are labelled r0..r(count-1) so a split can be checked for lost or
 * duplicated rows.
 */
function measuredTable(count: number, options: TableOptions = {}): HTMLTableElement {
  const { shape = "crepe", headColSpan = 1, tallRow, border = 0 } = options;
  const rowHeight = (i: number): number => (i === tallRow ? 900 : 100);
  const rowTop = (i: number): number => Array.from({ length: i }, (_, j) => rowHeight(j)).reduce((a, b) => a + b, 0);
  const table = document.createElement("table");
  Object.defineProperty(table, "offsetHeight", { value: 40 + rowTop(count) + border });
  const head = shape === "none" ? 0 : 40;
  table.getBoundingClientRect = () => DOMRect.fromRect({ height: head + rowTop(count) + border });
  Object.defineProperty(table, "offsetWidth", { value: 420 });

  const headerRow = document.createElement("tr");
  Object.defineProperty(headerRow, "offsetHeight", { value: 40 });
  headerRow.getBoundingClientRect = () => DOMRect.fromRect({ height: 40 });
  ["Feature", "Status"].forEach((text, i) => {
    const cell = document.createElement(shape === "attribute-only" ? "td" : "th");
    cell.textContent = text;
    Object.defineProperty(cell, "offsetWidth", { value: [120, 300][i] });
    headerRow.appendChild(cell);
  });
  headerRow.cells[0].colSpan = headColSpan;
  if (shape === "crepe" || shape === "attribute-only") headerRow.dataset.isHeader = "true";

  // Crepe's own tbody attributes; the split pieces must keep them.
  const body = document.createElement("tbody");
  body.className = "content-dom";
  body.dataset.contentDom = "true";

  if (shape === "thead") {
    const section = document.createElement("thead");
    Object.defineProperty(section, "offsetHeight", { value: 40 });
    section.appendChild(headerRow);
    table.appendChild(section);
  } else if (shape !== "none") {
    body.appendChild(headerRow);
  }

  for (let i = 0; i < count; i++) {
    const tr = document.createElement("tr");
    Object.defineProperty(tr, "offsetTop", { value: rowTop(i) });
    // A row moved into a piece that is not placed yet measures nothing, as in a
    // browser, where only what is in the document is laid out.
    Object.defineProperty(tr, "offsetHeight", {
      get: () => (tr.closest("table")?.parentElement ? rowHeight(i) : 0),
    });
    tr.getBoundingClientRect = () => DOMRect.fromRect({ y: head + rowTop(i), height: rowHeight(i) });
    for (const text of [`r${i}`, "M1"]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

function flowWith(block: HTMLElement): HTMLElement {
  const flow = document.createElement("div");
  flow.appendChild(block);
  return flow;
}

/**
 * A table inside Crepe's wrappers: `div.milkdown-table-block > div.table-wrapper >
 * table`. The block is what the paginator sees as a flow child, and it is 12px
 * taller than the table it holds.
 */
function wrappedTable(table: HTMLTableElement): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";
  wrapper.appendChild(table);
  const block = document.createElement("div");
  block.className = "milkdown-table-block";
  block.appendChild(wrapper);
  Object.defineProperty(block, "offsetHeight", { value: table.offsetHeight + 12 });
  return block;
}

const pieces = (flow: HTMLElement): HTMLTableElement[] =>
  Array.from(flow.querySelectorAll("table"));

const colWidths = (t: Element): string[] =>
  Array.from(t.querySelectorAll("col")).map((c) => (c as HTMLElement).style.width);

/** The r0..rN labels a piece carries, in order, ignoring any header row. */
const bodyLabels = (t: Element): string[] =>
  Array.from(t.querySelectorAll("tr"))
    .filter((r) => !(r as HTMLTableRowElement).dataset.isHeader && !r.closest("thead"))
    .map((r) => r.firstElementChild?.textContent ?? "");

describe("splitIntoPages, splitting an over-tall table", () => {
  it("repeats a Crepe header row on every piece", () => {
    // Crepe puts every row in one `<tbody>` and marks the header with
    // `data-is-header`, so `table.tHead` is null: a splitter that reads only
    // `tHead` leaves every page after the first without column names.
    const flow = flowWith(measuredTable(6));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const first = part.querySelector("tr")!;
      expect((first as HTMLTableRowElement).dataset.isHeader).toBe("true");
      expect(first.textContent).toBe("FeatureStatus");
      // Exactly one header, i.e. the original was moved out of the body rows.
      expect(part.querySelectorAll("tr[data-is-header]")).toHaveLength(1);
    }
    // Every row lands on exactly one piece, in order, none lost or duplicated.
    expect(parts.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("keeps the row container's own attributes on every piece", () => {
    // Crepe styles the body through `data-content-dom`/`.content-dom`; rebuilding
    // the pieces with a bare <tbody> would silently restyle the printed table.
    const flow = flowWith(measuredTable(6));
    splitIntoPages(flow, 250);

    for (const part of pieces(flow)) {
      const body = part.querySelector("tbody")!;
      expect(body.className).toBe("content-dom");
      expect((body as HTMLElement).dataset.contentDom).toBe("true");
    }
  });

  it("recognises the header from `data-is-header` alone, without <th> cells", () => {
    const flow = flowWith(measuredTable(6, { shape: "attribute-only" }));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.querySelector("tr")!.textContent).toBe("FeatureStatus");
    }
    expect(parts.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("repeats a real <thead> as a section, not as a body row", () => {
    const flow = flowWith(measuredTable(6, { shape: "thead" }));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.querySelectorAll("thead > tr")).toHaveLength(1);
      expect(part.querySelector("thead")!.textContent).toBe("FeatureStatus");
    }
    expect(parts.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("splits a headerless table without inventing a header or dropping a row", () => {
    const flow = flowWith(measuredTable(6, { shape: "none" }));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
    // No row is duplicated onto a later piece to stand in for a header.
    expect(parts.flatMap((p) => Array.from(p.querySelectorAll("tr")))).toHaveLength(6);
  });

  it("gives every piece the whole table's column widths so the fragments line up", () => {
    // Columns are content-sized (`table-layout: auto`), so a piece left to
    // re-measure against its own rows would come out a different shape.
    const flow = flowWith(measuredTable(6));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.style.tableLayout).toBe("fixed");
      expect(part.style.width).toBe("420px");
      expect(colWidths(part)).toEqual(["120px", "300px"]);
    }
  });

  it("leaves the pieces unpinned when a merged header cell makes column widths meaningless", () => {
    // Markdown tables have no colspan, so this is a guard: better to let the
    // browser lay each piece out than to pin two columns onto three.
    const flow = flowWith(measuredTable(6, { headColSpan: 2 }));
    splitIntoPages(flow, 250);

    const parts = pieces(flow);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.style.tableLayout).toBe("");
      expect(colWidths(part)).toEqual([]);
    }
  });

  it("splits a table wrapped in Crepe's block divs, rebuilding the wrappers", () => {
    // The flow child is `div.milkdown-table-block`, not the table: dispatching on
    // the block's own tag name found nothing to split, so an over-tall table was
    // clipped at the page edge and lost its last rows outright.
    const flow = flowWith(wrappedTable(measuredTable(6)));
    splitIntoPages(flow, 250);

    const blocks = Array.from(flow.children) as HTMLElement[];
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.className).toBe("milkdown-table-block");
      const inner = block.firstElementChild as HTMLElement;
      expect(inner.className).toBe("table-wrapper");
      expect(inner.firstElementChild!.tagName).toBe("TABLE");
      // The header still rides along on every piece.
      expect(block.querySelectorAll("tr[data-is-header]")).toHaveLength(1);
    }
    expect(blocks.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("splits the tallest candidate when a block holds more than one", () => {
    // Crepe mounts an empty drag-ghost table alongside the real one. Splitting the
    // ghost would produce empty pieces and drop the document's rows.
    const real = measuredTable(6);
    const block = wrappedTable(real);
    const ghost = document.createElement("table");
    Object.defineProperty(ghost, "offsetHeight", { value: 0 });
    block.insertBefore(ghost, block.firstChild);

    const flow = flowWith(block);
    splitIntoPages(flow, 250);

    const blocks = Array.from(flow.children) as HTMLElement[];
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("leaves a table that fits on one page alone", () => {
    const flow = flowWith(measuredTable(2));
    splitIntoPages(flow, 5000);

    const parts = pieces(flow);
    expect(parts).toHaveLength(1);
    // Untouched: no colgroup, no pinned layout, no duplicated header.
    expect(parts[0].style.tableLayout).toBe("");
    expect(colWidths(parts[0])).toEqual([]);
    expect(parts[0].querySelectorAll("tr[data-is-header]")).toHaveLength(1);
  });
});

/**
 * A Crepe code block: `div.milkdown-code-block > div.codemirror-host >
 * div.cm-editor > div.cm-scroller > (div.cm-gutters, div.cm-content)`, measured as
 * if laid out. Each code line is 18px while its gutter number is 19px — the real
 * one-pixel-per-line difference that made packing against the text alone overflow.
 */
function codeBlock(lineCount: number, renderedNumbers = lineCount): HTMLElement {
  const LINE = 18;
  const CELL = 19;
  const PADDING = 8;
  const BLOCK_CHROME = 28;

  const content = document.createElement("div");
  content.className = "cm-content";
  // CodeMirror pads the content box, and offsets the gutter's first cell to match.
  content.style.paddingTop = `${PADDING / 2}px`;
  Object.defineProperty(content, "offsetHeight", { value: lineCount * LINE + PADDING });
  for (let i = 0; i < lineCount; i++) {
    const line = document.createElement("div");
    line.className = "cm-line";
    Object.defineProperty(line, "offsetHeight", { value: LINE });
    // jsdom does no layout; the gutter reads the sub-pixel height from here.
    line.getBoundingClientRect = () => ({ height: LINE }) as DOMRect;
    // A highlight span, to show the real elements are moved rather than rebuilt.
    const token = document.createElement("span");
    token.className = "tok-keyword";
    token.textContent = `line ${i + 1}`;
    line.appendChild(token);
    content.appendChild(line);
  }

  const column = document.createElement("div");
  column.className = "cm-gutter cm-lineNumbers";
  // CodeMirror's hidden, zero-height width-measuring cell always leads the column.
  const spacer = document.createElement("div");
  spacer.className = "cm-gutterElement";
  spacer.textContent = "99";
  Object.defineProperty(spacer, "offsetHeight", { value: 0 });
  column.appendChild(spacer);
  // CodeMirror renders cells for the lines it has in view, which can be fewer than
  // the block holds — `renderedNumbers` models that. The numbers it does render
  // are the *last* ones, as when the top of a tall block has scrolled out.
  for (let i = lineCount - renderedNumbers; i < lineCount; i++) {
    const cell = document.createElement("div");
    cell.className = "cm-gutterElement";
    cell.textContent = String(i + 1);
    Object.defineProperty(cell, "offsetHeight", { value: CELL });
    column.appendChild(cell);
  }
  const gutters = document.createElement("div");
  gutters.className = "cm-gutters";
  gutters.style.minHeight = `${lineCount * CELL}px`;
  gutters.appendChild(column);

  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  Object.defineProperty(scroller, "offsetHeight", {
    value: Math.max(lineCount * CELL, lineCount * LINE + PADDING),
  });
  scroller.append(gutters, content);

  const editor = document.createElement("div");
  editor.className = "cm-editor";
  const host = document.createElement("div");
  host.className = "codemirror-host";
  const block = document.createElement("div");
  block.className = "milkdown-code-block";
  Object.defineProperty(block, "offsetHeight", {
    value: (scroller as HTMLElement).offsetHeight + BLOCK_CHROME,
  });
  editor.appendChild(scroller);
  host.appendChild(editor);
  block.appendChild(host);
  return block;
}

/** Every gutter number a piece shows, ignoring the hidden measuring spacer. */
const gutterNumbersOf = (el: Element): string[] =>
  Array.from(el.querySelectorAll(".cm-gutterElement"))
    .map((c) => c.textContent ?? "")
    .filter((t) => t !== "99");

const codeLinesOf = (el: Element): string[] =>
  Array.from(el.querySelectorAll(".cm-line")).map((l) => l.textContent ?? "");

describe("splitIntoPages, splitting a Crepe code block", () => {
  it("splits CodeMirror between source lines, carrying the line numbers along", () => {
    // Crepe renders code through CodeMirror, not a `<pre>`, so `splitPre` never
    // matched it and an over-tall code block was clipped at the page edge.
    const flow = flowWith(codeBlock(60));
    splitIntoPages(flow, 500);

    const blocks = Array.from(flow.children) as HTMLElement[];
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.className).toBe("milkdown-code-block");
      expect(block.querySelector(".codemirror-host > .cm-editor > .cm-scroller")).not.toBeNull();
      // The measuring spacer rides along so the column keeps its width...
      expect(block.querySelectorAll(".cm-gutterElement")[0].textContent).toBe("99");
      // ...but CodeMirror's pinned full-document height must not.
      expect(block.querySelector<HTMLElement>(".cm-gutters")!.style.minHeight).toBe("");
      // Each piece's numbers match its own lines, one for one.
      expect(gutterNumbersOf(block)).toHaveLength(codeLinesOf(block).length);
    }
    // Numbers run 1..60 unbroken across the pieces, and so does the code.
    const expected = Array.from({ length: 60 }, (_, i) => String(i + 1));
    expect(blocks.flatMap(gutterNumbersOf)).toEqual(expected);
    expect(blocks.flatMap(codeLinesOf)).toEqual(expected.map((n) => `line ${n}`));
    // Highlighting survives: the original spans were moved, not re-created.
    expect(blocks[0].querySelector(".cm-line .tok-keyword")).not.toBeNull();
  });

  it("pins each number's box to the height of the line it labels", () => {
    // CodeMirror measured its cells in the editor (19px here) while the print
    // surface sets code at another size (18px). Keeping the editor's height drifted
    // the numbers a fraction of a pixel per line, so half a page down a number sat
    // nearly two lines below its own code.
    const flow = flowWith(codeBlock(60));
    splitIntoPages(flow, 500);

    for (const block of Array.from(flow.children) as HTMLElement[]) {
      const cells = Array.from(block.querySelectorAll<HTMLElement>(".cm-gutterElement")).filter(
        (c) => c.textContent !== "99",
      );
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) expect(cell.style.height).toBe("18px");
    }
  });

  it("keeps each piece inside the height it was given", () => {
    const flow = flowWith(codeBlock(60));
    splitIntoPages(flow, 500);

    for (const block of Array.from(flow.children) as HTMLElement[]) {
      const lines = block.querySelectorAll(".cm-line").length;
      // 500 less the block chrome (28) and the content padding (8) leaves 464px.
      expect(lines * 18).toBeLessThanOrEqual(464);
    }
  });

  it("offsets each piece's first number to line up with the content's padding", () => {
    // Every piece starts a fresh column, so every piece needs the offset that
    // CodeMirror only puts on the original's first cell — without it the numbers
    // sit a few pixels above the lines they label, on every page.
    const flow = flowWith(codeBlock(60));
    splitIntoPages(flow, 500);

    for (const block of Array.from(flow.children) as HTMLElement[]) {
      const cells = Array.from(block.querySelectorAll<HTMLElement>(".cm-gutterElement")).filter(
        (c) => c.textContent !== "99",
      );
      expect(cells[0].style.marginTop).toBe("4px");
      expect(cells[1].style.marginTop).toBe("");
    }
  });

  it("numbers every line even when CodeMirror rendered fewer cells than lines", () => {
    // The real failure: inside the split editor a 60-line block came back with 59
    // rendered gutter cells, and taking the numbers positionally out of that column
    // put every one of them a line out (the printout started at 2).
    const flow = flowWith(codeBlock(60, 59));
    splitIntoPages(flow, 500);

    const blocks = Array.from(flow.children) as HTMLElement[];
    expect(blocks.length).toBeGreaterThan(1);
    const expected = Array.from({ length: 60 }, (_, i) => String(i + 1));
    expect(blocks.flatMap(gutterNumbersOf)).toEqual(expected);
    expect(blocks.flatMap(codeLinesOf)).toEqual(expected.map((n) => `line ${n}`));
    // Each number sits beside its own line.
    for (const block of blocks) {
      expect(gutterNumbersOf(block)).toHaveLength(codeLinesOf(block).length);
    }
  });
});

describe("splitIntoPages, splitting a Crepe list", () => {
  it("splits a list whose items are wrapped in Crepe's item blocks", () => {
    // Crepe renders `<ul><div class="milkdown-list-item-block"><li>…`, so matching
    // only `LI` children found no items and the list was clipped at the page edge.
    const list = document.createElement("ul");
    Object.defineProperty(list, "offsetHeight", { value: 40 * 32 });
    for (let i = 0; i < 40; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "milkdown-list-item-block";
      Object.defineProperty(wrapper, "offsetTop", { value: i * 32 });
      Object.defineProperty(wrapper, "offsetHeight", { value: 32 });
      const li = document.createElement("li");
      li.textContent = `item ${i + 1}`;
      wrapper.appendChild(li);
      list.appendChild(wrapper);
    }

    const flow = flowWith(list);
    splitIntoPages(flow, 500);

    const parts = Array.from(flow.children) as HTMLElement[];
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.tagName).toBe("UL");
    const items = parts.flatMap((p) =>
      Array.from(p.querySelectorAll("li")).map((li) => li.textContent),
    );
    expect(items).toEqual(Array.from({ length: 40 }, (_, i) => `item ${i + 1}`));
  });
});

describe("splitIntoPages, splitting a Markdown source line", () => {
  /** Line box and text box heights of the fake layout below. */
  const LINE_BOX = 18;
  const TEXT_BOX = 14;
  /** The wrapped line each character of a laid-out text node sits on. */
  const wrappedLines = new Map<Node, number[]>();

  beforeEach(() => {
    // jsdom has no layout and no Range geometry. A character's box is its line's
    // text box, centred in the line box as Chromium reports it.
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        const line = wrappedLines.get(this.startContainer)![this.startOffset];
        const top = line * LINE_BOX + (LINE_BOX - TEXT_BOX) / 2;
        return DOMRect.fromRect({ x: 0, y: top, width: 7, height: TEXT_BOX });
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    wrappedLines.clear();
  });

  /**
   * A `.print-src-line` laid out as if in a monospace face `columns` characters
   * wide: it wraps before a word that would not fit, and the spaces after a word
   * stay at the end of its line, as `white-space: pre-wrap` hangs them.
   */
  function sourceLine(text: string, columns: number): HTMLElement {
    const lines: number[] = [];
    let line = 0;
    let column = 0;
    for (const word of text.split(/(?<= )/)) {
      if (column > 0 && column + word.trimEnd().length > columns) {
        line++;
        column = 0;
      }
      for (let i = 0; i < word.length; i++) lines.push(line);
      column += word.length;
    }
    const el = document.createElement("div");
    el.className = "print-src-line";
    el.textContent = text;
    wrappedLines.set(el.firstChild!, lines);
    const height = (line + 1) * LINE_BOX;
    Object.defineProperty(el, "offsetHeight", { value: height });
    el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 280, height });
    return el;
  }

  it("continues a line taller than a page on the next pages, between its wrapped lines", () => {
    // Each source line printed as one block, so a line taller than a page was
    // clipped at the page edge and everything after its first page was lost.
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const before = sourceLine("# Notes", 40);
    const long = sourceLine(words, 40);
    const after = sourceLine("The end.", 40);
    const lineOf = wrappedLines.get(long.firstChild!)!;
    const flow = document.createElement("div");
    flow.append(before, long, after);

    splitIntoPages(flow, 500);

    const blocks = Array.from(flow.children) as HTMLElement[];
    expect(blocks[0]).toBe(before);
    expect(blocks[blocks.length - 1]).toBe(after);
    const pieces = blocks.slice(1, -1);
    expect(pieces.length).toBeGreaterThan(1);
    // Every character prints once, in order.
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(words);
    let start = 0;
    pieces.forEach((piece, index) => {
      expect(piece.className).toBe("print-src-line");
      const end = start + piece.textContent!.length;
      // A piece starts where a wrapped line starts...
      if (start > 0) expect(lineOf[start]).toBe(lineOf[start - 1] + 1);
      // ...and fills a page with whole lines: 27 lines of 18px fit in 500px.
      const lines = lineOf[end - 1] - lineOf[start] + 1;
      if (index < pieces.length - 1) expect(lines).toBe(27);
      else expect(lines).toBeLessThanOrEqual(27);
      start = end;
    });
  });
});

/**
 * A fake layout, since jsdom lays nothing out. Elements say how they measure:
 * - `data-text-layout` wraps its text word by word at COLUMNS monospace columns,
 *   in lines of LINE px with the glyphs TEXT px tall in the middle, inside PAD px
 *   of padding. An element laid out as an inline block inside it is one box over
 *   the columns its text takes. `data-text-layout="rtl-run"` sets each line as
 *   one right-to-left run in a left-to-right block, as Chromium lays out Hebrew
 *   or Arabic when no direction is set: the line's first character at the right
 *   end of the run, its last at the left edge.
 * - `data-columns` on an element inside such a block makes each of its
 *   characters that many columns wide, as a bold face can be wider than the
 *   regular one.
 * - `data-stack` stacks its children, each starting where the one before ends,
 *   inside its own vertical padding.
 * - `data-row` sets its children side by side and is as tall as the tallest.
 * - `data-height` is that many px tall.
 * - A line of code that print rebuilds (`.print-code-line`) is LINE px tall.
 * - The box of an element measured by these rules is its offsetTop and height.
 * Copies of an element (the splitter's trial pieces and the pieces themselves)
 * keep the mark, so they measure by the same rules.
 */
const fakeLayout = (() => {
  const LINE = 18;
  const TEXT = 14;
  const PAD = 4;
  const CHAR = 7;
  const COLUMNS = 40;
  const saved: [object, string, PropertyDescriptor | undefined][] = [];

  /**
   * Where each character of `text` is laid out: words wrap, spaces hang.
   * `widths` holds the columns each character takes, 1 where it has none.
   */
  function wrap(text: string, widths: number[] = []): { line: number; column: number }[] {
    const places: { line: number; column: number }[] = [];
    let line = 0;
    let column = 0;
    let index = 0;
    for (const word of text.split(/(?<= )/)) {
      let size = 0;
      for (let i = 0; i < word.trimEnd().length; i++) size += widths[index + i] ?? 1;
      if (column > 0 && column + size > COLUMNS) {
        line++;
        column = 0;
      }
      for (let i = 0; i < word.length; i++) {
        places.push({ line, column });
        column += widths[index++] ?? 1;
      }
    }
    return places;
  }

  const blockOf = (node: Node): HTMLElement | null =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-text-layout]") ?? null;

  /** The columns each character of a text block takes (`data-columns`). */
  function widthsOf(block: HTMLElement): number[] {
    const widths: number[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const wide = text.parentElement?.closest<HTMLElement>("[data-columns]");
      const columns = wide && block.contains(wide) ? Number(wide.dataset.columns) : 1;
      widths.push(...Array.from({ length: (text as Text).data.length }, () => columns));
    }
    return widths;
  }

  /** The offset of `node`'s first character in its block's text. */
  function offsetIn(block: HTMLElement, node: Node): number {
    let offset = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (node === text || node.contains(text)) return offset;
      offset += (text as Text).data.length;
    }
    return offset;
  }

  /**
   * The lines of a text block: each LINE px tall, or as tall as an inline box
   * with `data-height` on it, which sits on the line with the text on its bottom.
   */
  function linesOf(block: HTMLElement): { places: { line: number; column: number }[]; tops: number[]; heights: number[]; widths: number[] } {
    const widths = widthsOf(block);
    const places = wrap(block.textContent ?? "", widths);
    const heights = Array.from({ length: places.length ? places[places.length - 1].line + 1 : 1 }, () => LINE);
    for (const box of Array.from(block.querySelectorAll<HTMLElement>("[data-height]"))) {
      const line = places[offsetIn(block, box)].line;
      heights[line] = Math.max(heights[line], Number(box.dataset.height));
    }
    const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
    return { places, tops, heights, widths };
  }

  const textHeight = (block: HTMLElement): number =>
    PAD * 2 + linesOf(block).heights.reduce((a, b) => a + b, 0);

  /** The fake height of `el`, or null when it carries no mark. */
  function heightOf(el: HTMLElement): number | null {
    if (el.dataset.height) return Number(el.dataset.height);
    if (el.matches("[data-text-layout]")) return textHeight(el);
    if (el.classList.contains("print-code-line")) return LINE;
    const children = Array.from(el.children) as HTMLElement[];
    const padding = (Number.parseFloat(el.style.paddingTop) || 0) + (Number.parseFloat(el.style.paddingBottom) || 0);
    if (el.matches("[data-stack]")) return children.reduce((sum, child) => sum + child.offsetHeight, padding);
    if (el.matches("[data-row]")) return Math.max(0, ...children.map((child) => child.offsetHeight));
    return null;
  }

  /** The box of `length` characters from `offset` in `block`, or of an inline box `height` px tall there. */
  function charBox(block: HTMLElement, offset: number, length: number, height?: number): DOMRect {
    const { places, tops, heights, widths } = linesOf(block);
    const { line, column } = places[offset];
    const top = height ? PAD + tops[line] : PAD + tops[line] + heights[line] - LINE + (LINE - TEXT) / 2;
    const columns = widths.slice(offset, offset + length).reduce((a, b) => a + b, 0);
    let x = column;
    if (block.dataset.textLayout === "rtl-run") {
      const width = widths.filter((_, i) => places[i].line === line).reduce((a, b) => a + b, 0);
      x = width - column - columns;
    }
    return DOMRect.fromRect({ x: x * CHAR, y: top, width: CHAR * columns, height: height ?? TEXT });
  }

  function override(target: object, name: string, descriptor: PropertyDescriptor): void {
    saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
  }

  return {
    LINE,
    PAD,
    wrap,
    install(): void {
      const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
      override(HTMLElement.prototype, "offsetHeight", {
        get(this: HTMLElement) {
          return heightOf(this) ?? height.get!.call(this);
        },
      });
      const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
      override(HTMLElement.prototype, "offsetTop", {
        get(this: HTMLElement) {
          const parent = this.parentElement;
          if (!parent?.matches("[data-stack]")) return top.get!.call(this);
          let offset = parent.offsetTop + (Number.parseFloat(parent.style.paddingTop) || 0);
          for (let sibling = this.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            offset += (sibling as HTMLElement).offsetHeight;
          }
          return offset;
        },
      });
      const elementBox = Element.prototype.getBoundingClientRect;
      override(Element.prototype, "getBoundingClientRect", {
        value(this: Element) {
          const block = blockOf(this);
          if (!block) {
            const height = this instanceof HTMLElement ? heightOf(this) : null;
            return height === null ? elementBox.call(this) : DOMRect.fromRect({ y: (this as HTMLElement).offsetTop, height });
          }
          if (block === this) return DOMRect.fromRect({ width: COLUMNS * CHAR, height: textHeight(block) });
          const height = this instanceof HTMLElement && this.dataset.height ? Number(this.dataset.height) : undefined;
          return charBox(block, offsetIn(block, this), (this.textContent ?? "").length, height);
        },
      });
      override(Range.prototype, "getBoundingClientRect", {
        value(this: Range) {
          const block = blockOf(this.startContainer)!;
          return charBox(block, offsetIn(block, this.startContainer) + this.startOffset, 1);
        },
      });
    },
    uninstall(): void {
      for (const [target, name, descriptor] of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else Reflect.deleteProperty(target, name);
      }
      saved.length = 0;
    },
  };
})();

describe("splitIntoPages, splitting a paragraph or heading", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  /**
   * A block of 400 words with formatting that crosses where the pages break:
   * bold text, a link and two inline-code boxes. `layout` is its fake text
   * layout, and each word is `word` and its number.
   */
  function formattedBlock(tag: string, layout: string, word: string): HTMLElement {
    const words = (from: number, to: number): string =>
      Array.from({ length: to - from }, (_, i) => `${word}${from + i}`).join(" ");
    const block = document.createElement(tag);
    block.dataset.textLayout = layout;
    block.innerHTML =
      `${words(0, 100)} <strong class="mark">${words(100, 250)}</strong> ` +
      `<code style="display: inline-block">x=1</code> ${words(250, 262)} ` +
      `<a href="https://example.com/a" class="link">${words(262, 300)}</a> ` +
      `${words(300, 399)} <code style="display: inline-block">y=2</code>`;
    return block;
  }

  it.each([
    ["paragraph", "P", "", "word"],
    ["heading", "H2", "", "word"],
    // md-easy sets no text direction, so each line of a Hebrew paragraph is a
    // right-to-left run that starts at the right, not back at the left. Judged
    // by direction, the paragraph had no line breaks and was shrunk to fit.
    ["Hebrew paragraph", "P", "rtl-run", "מילה"],
  ])(
    "continues a %s taller than a page between its wrapped lines, keeping its formatting",
    (_kind, tag, layout, word) => {
      // A text block printed as one block, so the page body clipped everything
      // after its first page.
      const block = formattedBlock(tag, layout, word);
      const text = block.textContent!;
      const strong = block.querySelector("strong")!.textContent;
      const link = block.querySelector("a")!.textContent;
      const flow = document.createElement("div");
      flow.append(block);

      splitIntoPages(flow, 500);

      const pieces = Array.from(flow.children) as HTMLElement[];
      expect(pieces.length).toBeGreaterThan(2);
      // Every character prints once, in order.
      expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
      const places = fakeLayout.wrap(text);
      let start = 0;
      pieces.forEach((piece, index) => {
        expect(piece.tagName).toBe(tag);
        // A piece starts where a wrapped line starts...
        if (start > 0) expect(places[start]).toEqual({ line: places[start - 1].line + 1, column: 0 });
        // ...and fills a page with whole lines: 27 lines of 18px and the padding fit in 500px.
        const end = start + piece.textContent!.length;
        const lines = places[end - 1].line - places[start].line + 1;
        if (index < pieces.length - 1) expect(lines).toBe(27);
        else expect(lines).toBeLessThanOrEqual(27);
        start = end;
      });
      // Bold text and the link continue on the next page with their attributes.
      const bold = pieces.flatMap((piece) => Array.from(piece.querySelectorAll("strong")));
      expect(bold.length).toBeGreaterThan(1);
      for (const part of bold) expect(part.className).toBe("mark");
      expect(bold.map((part) => part.textContent).join("")).toBe(strong);
      const links = pieces.flatMap((piece) => Array.from(piece.querySelectorAll("a")));
      expect(links.length).toBeGreaterThan(1);
      for (const part of links) {
        expect(part.getAttribute("href")).toBe("https://example.com/a");
        expect(part.className).toBe("link");
      }
      expect(links.map((part) => part.textContent).join("")).toBe(link);
      // Inline code prints whole, once each.
      const code = pieces.flatMap((piece) => Array.from(piece.querySelectorAll("code")));
      expect(code.map((box) => box.textContent)).toEqual(["x=1", "y=2"]);
    },
  );

  it("splits a heading that fits a page only without its top margin", () => {
    // The check for a block taller than a page left out the block's top
    // margin, which the page makes room for above it, so such a heading was
    // left whole and the page body cut off its last line.
    const heading = document.createElement("h2");
    heading.dataset.textLayout = "";
    heading.style.marginTop = "28px";
    // 27 lines of 8 words.
    heading.textContent = Array.from({ length: 216 }, (_, i) => `w${String(i).padStart(3, "0")}`).join(" ");
    const text = heading.textContent;
    expect(heading.offsetHeight).toBeLessThanOrEqual(500);
    expect(heading.offsetHeight + 28).toBeGreaterThan(500);
    const flow = flowWith(heading);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece.tagName).toBe("H2");
      expect(piece.offsetHeight + 28).toBeLessThanOrEqual(500);
    }
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
  });

  it("measures a piece that lies wholly inside bold text in bold", () => {
    // The trial copy of such a piece left out the bold element around it, so
    // it was measured in plain text, and with bold text wider than plain text
    // the piece ran past the page.
    const words = (label: string, count: number): string =>
      Array.from({ length: count }, (_, i) => `${label}${i}`).join(" ");
    const block = document.createElement("p");
    block.dataset.textLayout = "";
    block.innerHTML = `${words("w", 100)} <strong data-columns="2">${words("b", 600)}</strong> end.`;
    const text = block.textContent;
    const flow = flowWith(block);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    // Some pieces hold nothing but bold text.
    expect(pieces.filter((piece) => piece.childNodes.length === 1 && piece.firstElementChild?.tagName === "STRONG").length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.offsetHeight).toBeLessThanOrEqual(500);
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
  });
});

/** An element of a fake-layout tree: `data-height` px tall, holding `text`. */
function sized(tag: string, height: number, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.height = String(height);
  el.textContent = text;
  return el;
}

/** An element that stacks `children` in the fake layout. */
function stack(tag: string, ...children: HTMLElement[]): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.stack = "";
  el.append(...children);
  return el;
}

const paragraphs = (count: number, label: string): HTMLElement[] =>
  Array.from({ length: count }, (_, i) => sized("p", 30, `${label}${i + 1}.`));

/** A text block of `count` words in the fake text layout: 5 words to a line. */
function longParagraph(count: number, label: string): HTMLElement {
  const p = document.createElement("p");
  p.dataset.textLayout = "";
  p.textContent = Array.from({ length: count }, (_, i) => `${label}${i + 1}`).join(" ");
  return p;
}

describe("splitIntoPages, splitting a quote", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  it("splits a quote taller than a page between its paragraphs", () => {
    // A quote printed as one block, so the page body clipped every paragraph
    // after its first page.
    const quote = stack("blockquote", ...paragraphs(40, "q"));
    quote.className = "note";
    const flow = flowWith(quote);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.length).toBe(3);
    for (const piece of pieces) {
      expect(piece.tagName).toBe("BLOCKQUOTE");
      expect(piece.className).toBe("note");
      expect(piece.offsetHeight).toBeLessThanOrEqual(500);
    }
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(
      Array.from({ length: 40 }, (_, i) => `q${i + 1}.`).join(""),
    );
  });

  it("splits a nested quote and a long paragraph inside a quote by the same rules", () => {
    const inner = stack("blockquote", ...paragraphs(40, "n"));
    const long = longParagraph(400, "w");
    const outer = stack("blockquote", sized("p", 30, "first."), inner, long, sized("p", 30, "last."));
    const text = outer.textContent;
    const flow = flowWith(outer);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.length).toBeGreaterThan(4);
    for (const piece of pieces) {
      expect(piece.tagName).toBe("BLOCKQUOTE");
      expect(piece.offsetHeight).toBeLessThanOrEqual(500);
    }
    // Every character prints once, in order.
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
    // The nested quote and the long paragraph each continue over several pieces,
    // still a quote inside the quote and a paragraph.
    const nested = pieces.filter((piece) => piece.querySelector(":scope > blockquote"));
    expect(nested.length).toBeGreaterThan(1);
    const words = pieces.filter((piece) => piece.querySelector(":scope > p[data-text-layout]"));
    expect(words.length).toBeGreaterThan(1);
  });

  it("keeps the rest of a quote that holds a list taller than a page", () => {
    // The paginator used to split only the list inside the quote and rebuild the
    // quote around each piece of it, which left out the quote's other blocks.
    const items = Array.from({ length: 40 }, (_, i) => {
      const wrapper = sized("div", 30, "");
      wrapper.className = "milkdown-list-item-block";
      wrapper.append(sized("li", 30, `item ${i + 1}`));
      return wrapper;
    });
    const quote = stack("blockquote", sized("p", 30, "Before the list."), stack("ul", ...items), sized("p", 30, "After the list."));
    const text = quote.textContent;
    const flow = flowWith(quote);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.tagName).toBe("BLOCKQUOTE");
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
  });

  it("splits a quote that fits a page only without the margin of the heading it begins with", () => {
    // The heading's 28 px margin collapses with the quote's 4 px into one
    // above the quote. The check for a block taller than a page counted only
    // the quote's, so the quote was left whole and the page body cut off its end.
    const heading = sized("h2", 300, "Heading.");
    heading.style.marginTop = "28px";
    const quote = stack("blockquote", heading, sized("p", 180, "Last."));
    quote.style.marginTop = "4px";
    const flow = flowWith(quote);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.map((piece) => piece.textContent)).toEqual(["Heading.", "Last."]);
    for (const piece of pieces) expect(piece.tagName).toBe("BLOCKQUOTE");
  });

  it("leaves whole a block in a quote that fits a page with the margin it shares with the quote", () => {
    // The image block's 4 px margin and the quote's collapse into one. Counting
    // both made the image look too tall for a page, so it was shrunk.
    const image = sized("div", 494, "IMAGE");
    image.className = "milkdown-image-block";
    image.style.marginTop = "4px";
    const quote = stack("blockquote", ...paragraphs(10, "a"), image, ...paragraphs(10, "b"));
    quote.style.marginTop = "4px";
    const text = quote.textContent;
    const flow = flowWith(quote);

    splitIntoPages(flow, 500);

    expect(flow.querySelector(".print-fit")).toBeNull();
    expect(image.style.transform).toBe("");
    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.map((piece) => piece.textContent)).toEqual([
      paragraphs(10, "a").map((p) => p.textContent).join(""),
      "IMAGE",
      paragraphs(10, "b").map((p) => p.textContent).join(""),
    ]);
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
  });
});

describe("splitIntoPages, keeping a heading with the block after it", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  const texts = (pages: Element[][]): string[][] => pages.map((page) => page.map((el) => el.textContent ?? ""));
  const text = (count: number, label: string): string[] => paragraphs(count, label).map((p) => p.textContent ?? "");

  it("moves a heading at the foot of a page to the next page, with the paragraph after it", () => {
    // 15 paragraphs and the heading fill 480 px of the 500 px page, and the
    // paragraph after it does not fit. The heading printed alone at the foot.
    const flow = stack("div", ...paragraphs(15, "a"), sized("h2", 30, "Heading."), sized("p", 30, "After."));

    expect(texts(splitIntoPages(flow, 500))).toEqual([text(15, "a"), ["Heading.", "After."]]);
  });

  it("moves a heading at the foot of a piece of a quote to the next piece", () => {
    const quote = stack("blockquote", ...paragraphs(15, "a"), sized("h3", 30, "Heading."), ...paragraphs(5, "b"));
    const flow = stack("div", quote);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children, (piece) => Array.from(piece.children, (child) => child.textContent));
    expect(pieces).toEqual([text(15, "a"), ["Heading.", ...text(5, "b")]]);
  });

  it("leaves a heading above a paragraph taller than a page at the foot of its page", () => {
    // The paragraph's first piece fills a page, so the heading cannot go with
    // it. Moving the heading would print it alone on a page.
    const flow = stack("div", sized("p", 30, "Intro."), sized("h2", 30, "Findings."), longParagraph(400, "w"));

    const pages = texts(splitIntoPages(flow, 500));

    expect(pages[0]).toEqual(["Intro.", "Findings."]);
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages.slice(1)) expect(page).toHaveLength(1);
  });
});

describe("splitIntoPages, splitting a footnote", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  /** A footnote definition as Crepe renders it: `dl > (dt, dd)`, the note's blocks in the `dd`. */
  function footnote(label: string, ...blocks: HTMLElement[]): HTMLElement {
    const note = stack("dl", sized("dt", 24, label), stack("dd", ...blocks));
    note.dataset.label = label;
    note.dataset.type = "footnote_definition";
    return note;
  }

  it.each([
    ["a long paragraph", () => [longParagraph(400, "w")]],
    ["many paragraphs", () => paragraphs(40, "p")],
    // 480 px of paragraphs fit the page by themselves, but not below the
    // 24 px label, so they were not split and the label printed alone.
    ["paragraphs that fill a page by themselves", () => paragraphs(16, "p")],
  ])(
    "splits a footnote taller than a page, of %s, between its blocks, its label with the first",
    (_kind, blocks) => {
      // The note was neither a quote nor a list, so nothing split it, and it was
      // shrunk onto one page.
      const note = footnote("long", ...blocks());
      const text = note.textContent;
      const flow = flowWith(note);

      splitIntoPages(flow, 500);

      const pieces = Array.from(flow.children) as HTMLElement[];
      expect(pieces.length).toBeGreaterThan(1);
      expect(flow.querySelector(".print-fit")).toBeNull();
      for (const piece of pieces) {
        expect(piece.tagName).toBe("DL");
        expect(piece.dataset.type).toBe("footnote_definition");
        expect(piece.offsetHeight).toBeLessThanOrEqual(500);
      }
      // Every character prints once, in order, and the label once, with the start
      // of the note rather than alone at the foot of the page before it.
      expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
      expect(flow.querySelectorAll("dt")).toHaveLength(1);
      expect(Array.from(pieces[0].children, (child) => child.tagName)).toEqual(["DT", "DD"]);
      for (const piece of pieces.slice(1)) {
        expect(Array.from(piece.children, (child) => child.tagName)).toEqual(["DD"]);
      }
    },
  );
});

/**
 * A list item as Crepe renders it, in the fake layout: the label beside the
 * content, `div.milkdown-list-item-block > li > (div.label-wrapper,
 * div.children > div.content-dom > blocks)`.
 */
function crepeItem(label: string, ...blocks: HTMLElement[]): HTMLElement {
  const content = stack("div", ...blocks);
  content.className = "content-dom";
  const children = stack("div", content);
  children.className = "children";
  const mark = sized("div", 32, label);
  mark.className = "label-wrapper";
  const li = document.createElement("li");
  li.className = "list-item";
  li.dataset.row = "";
  li.append(mark, children);
  const wrapper = stack("div", li);
  wrapper.className = "milkdown-list-item-block";
  return wrapper;
}

describe("splitIntoPages, splitting a list item", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  it("continues an item taller than a page on the next pages, showing its number once", () => {
    // An item printed as one block, so the page body clipped a long paragraph
    // under a number after its first page.
    const list = stack(
      "ol",
      crepeItem("1.", sized("p", 30, "First.")),
      crepeItem("2.", longParagraph(400, "w")),
      crepeItem("3.", sized("p", 30, "Third.")),
    );
    const visible = (el: Element): string => {
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('[style*="visibility: hidden"]').forEach((hidden) => hidden.remove());
      return copy.textContent ?? "";
    };
    const text = list.textContent;
    const flow = flowWith(list);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLOListElement[];
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(piece.tagName).toBe("OL");
      expect(piece.offsetHeight).toBeLessThanOrEqual(500);
    }
    // Every character prints once, in order, and each number shows once.
    expect(pieces.map(visible).join("")).toBe(text);
    const labels = pieces.flatMap((piece) => Array.from(piece.querySelectorAll<HTMLElement>(".label-wrapper")));
    expect(labels.filter((label) => !label.style.visibility).map((label) => label.textContent)).toEqual(["1.", "2.", "3."]);
    // The rest of item 2 keeps the item's shape, with its number hidden beside it
    // so the text keeps its indent.
    const rest = labels.filter((label) => label.style.visibility === "hidden");
    expect(rest.length).toBeGreaterThan(0);
    for (const label of rest) {
      expect(label.textContent).toBe("2.");
      expect(label.closest(".milkdown-list-item-block > li.list-item")).not.toBeNull();
      expect(label.nextElementSibling!.matches(".children")).toBe(true);
      expect(label.nextElementSibling!.querySelector(":scope > .content-dom > p")).not.toBeNull();
    }
    // Each piece starts counting at the item it begins with, so a continued item
    // keeps its number.
    for (const piece of pieces) {
      expect(piece.start).toBe(Number.parseInt(piece.querySelector(".label-wrapper")!.textContent!));
    }
  });
});

describe("splitIntoPages, shrinking what cannot be split", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  it.each([
    [960, "scale(0.25)"],
    // A factor below 1 percent: the shrink stopped at 1 percent, so the block
    // still reached past the page.
    [48_000, "scale(0.005)"],
  ])("shrinks a block %d px tall with nothing splittable in it to %s rather than letting the page cut it", (height, scale) => {
    // Such a block was left as it was, and the page body cut off all of it below
    // the first page.
    const block = document.createElement("div");
    block.className = "milkdown-image-block";
    block.style.marginTop = "10px";
    Object.defineProperty(block, "offsetHeight", { value: height });
    block.innerHTML = '<div class="image-wrapper"><img alt="a tall image"></div>';

    const flow = flowWith(block);
    splitIntoPages(flow, 250);
    // The block itself, whole, scaled into a frame as tall as the page has room for.
    const frame = flow.firstElementChild as HTMLElement;
    expect(Array.from(flow.children)).toEqual([frame]);
    expect(frame.className).toBe("print-fit");
    expect(Array.from(frame.children)).toEqual([block]);
    expect(frame.style.height).toBe("240px");
    expect(frame.style.marginTop).toBe("10px");
    expect(block.style.marginTop).toBe("0px");
    expect(block.style.transform).toBe(scale);
    expect(block.querySelector("img")).not.toBeNull();
  });

  it("shrinks a piece holding one row taller than a page, and only that piece", () => {
    const table = measuredTable(6, { tallRow: 2 });
    // Measure the pieces: each sums the rows it holds.
    table.dataset.stack = "";
    table.querySelector("tbody")!.dataset.stack = "";
    const flow = flowWith(table);
    splitIntoPages(flow, 250);

    const frames = Array.from(flow.querySelectorAll<HTMLElement>(".print-fit"));
    expect(frames).toHaveLength(1);
    expect(bodyLabels(frames[0])).toEqual(["r2"]);
    expect(pieces(flow).flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("gives a line taller than a page a piece of its own and shrinks it", () => {
    // An image inside a paragraph can make one line taller than a page; no break
    // between lines can make that line fit.
    const block = longParagraph(300, "w");
    const image = document.createElement("span");
    image.style.display = "inline-block";
    image.dataset.height = "900";
    image.textContent = "IMAGE";
    const words = block.firstChild as Text;
    block.insertBefore(image, words.splitText(words.data.indexOf("w150")));
    const text = block.textContent;
    const flow = flowWith(block);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
    const frames = pieces.filter((piece) => piece.className === "print-fit");
    expect(frames).toHaveLength(1);
    expect(frames[0].textContent).toContain("IMAGE");
    expect(frames[0].style.height).toBe("500px");
    for (const piece of pieces) expect(piece.offsetHeight).toBeLessThanOrEqual(500);
  });

  it("shrinks a block inside a quote that cannot be split, and splits the quote around it", () => {
    const image = sized("div", 900, "IMAGE");
    image.className = "milkdown-image-block";
    const quote = stack("blockquote", ...paragraphs(10, "a"), image, ...paragraphs(10, "b"));
    const text = quote.textContent;
    const flow = flowWith(quote);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(text);
    const frame = flow.querySelector<HTMLElement>(".print-fit")!;
    expect(frame.parentElement!.tagName).toBe("BLOCKQUOTE");
    expect(frame.firstElementChild).toBe(image);
    expect(frame.style.height).toBe("500px");
  });
});

describe("splitIntoPages, splitting a code block with a diagram", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  it("keeps a Mermaid diagram when its code is taller than a page", () => {
    // Only the code was split, and the code block was rebuilt around each piece
    // of it, which left the diagram below the code out of the print.
    const host = codeBlock(60).querySelector<HTMLElement>(".codemirror-host")!;
    // Measure the split pieces too: a scroller is as tall as the lines it holds.
    host.dataset.stack = "";
    host.querySelector<HTMLElement>(".cm-editor")!.dataset.stack = "";
    host.querySelector<HTMLElement>(".cm-scroller")!.dataset.row = "";
    host.querySelector<HTMLElement>(".cm-content")!.dataset.stack = "";
    const panel = sized("div", 300, "DIAGRAM");
    panel.className = "preview-panel";
    const block = stack("div", host, panel);
    block.className = "milkdown-code-block";
    const flow = flowWith(block);

    splitIntoPages(flow, 500);

    const pieces = Array.from(flow.children) as HTMLElement[];
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.className).toBe("milkdown-code-block");
      expect(piece.offsetHeight).toBeLessThanOrEqual(500);
    }
    expect(pieces.flatMap(codeLinesOf)).toEqual(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`));
    // The diagram prints once, after the last of the code.
    expect(flow.querySelectorAll(".preview-panel")).toHaveLength(1);
    expect(pieces[pieces.length - 1].lastElementChild).toBe(panel);
  });
});

describe("splitIntoPages, fitting each piece of a block with its top margin and padding", () => {
  beforeEach(() => fakeLayout.install());
  afterEach(() => fakeLayout.uninstall());

  // Each rebuilt piece repeats the block's 4 px top margin, which the page
  // makes room for above it, and the splitters left it out. Pieces of a table
  // or code block reached past the page by it, and by the padding of a code
  // block CodeMirror had not drawn yet.

  it("fits each piece of a table with the block's top margin and the table's border", () => {
    const block = wrappedTable(measuredTable(6, { border: 1 }));
    block.style.marginTop = "4px";
    const flow = flowWith(block);

    splitIntoPages(flow, 256);

    const parts = Array.from(flow.children) as HTMLElement[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap(bodyLabels)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
    // The margin, the wrappers (12), the header (40), the rows and the border fit.
    for (const part of parts) expect(4 + 12 + 40 + bodyLabels(part).length * 100 + 1).toBeLessThanOrEqual(256);
  });

  it("fits each piece of a CodeMirror code block with the block's top margin", () => {
    const block = codeBlock(60);
    block.style.marginTop = "4px";
    const flow = flowWith(block);

    splitIntoPages(flow, 470);

    const parts = Array.from(flow.children) as HTMLElement[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap(codeLinesOf)).toEqual(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`));
    // The margin, the block's chrome (28), the content's padding (8) and the lines fit.
    for (const part of parts) expect(4 + 28 + 8 + codeLinesOf(part).length * 18).toBeLessThanOrEqual(470);
  });

  it("fits each piece of a code block CodeMirror has not drawn with the block's margin and padding", () => {
    // Crepe shows a code block outside the window as a plain `pre` until it
    // scrolls into view, so a long document prints most of its code that way.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const code = document.createElement("code");
    code.dataset.stack = "";
    code.textContent = lines.join("\n");
    const pre = stack("pre", code);
    pre.className = "milkdown-code-block-placeholder";
    pre.style.padding = "4px 0";
    // Before the split the code is one text node, LINE px a line.
    Object.defineProperty(code, "offsetHeight", { get: () => (code.childElementCount || lines.length) * fakeLayout.LINE });
    const block = stack("div", pre);
    block.className = "milkdown-code-block";
    block.style.padding = "8px 20px 20px";
    block.style.marginTop = "4px";
    const flow = flowWith(block);

    splitIntoPages(flow, 500);

    const parts = Array.from(flow.children) as HTMLElement[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => Array.from(part.querySelectorAll(".print-code-line"), (line) => line.textContent))).toEqual(lines);
    for (const part of parts) {
      expect(part.className).toBe("milkdown-code-block");
      expect(part.offsetHeight + 4).toBeLessThanOrEqual(500);
    }
  });

  // In a quote, the block's 4 px margin and the quote's collapse into one
  // above each piece. Counting both left each piece of a table a row short
  // and each piece of a code block a line short of what fits the page.

  it("fits each piece of a table in a quote with the margin it shares with the quote, once", () => {
    const table = measuredTable(6, { border: 1 });
    const block = wrappedTable(table);
    block.style.marginTop = "4px";
    // Measure the pieces too: the wrappers' 12 px and the rows each holds.
    for (const level of [block, block.firstElementChild as HTMLElement, table, table.querySelector("tbody")!]) {
      level.dataset.stack = "";
    }
    (block.firstElementChild as HTMLElement).style.paddingTop = "12px";
    const quote = stack("blockquote", block);
    quote.style.marginTop = "4px";
    const flow = flowWith(quote);

    // The margin, the wrappers (12), the header (40), two rows and the border take 257 px.
    splitIntoPages(flow, 258);

    const parts = Array.from(flow.children) as HTMLElement[];
    for (const part of parts) expect(part.tagName).toBe("BLOCKQUOTE");
    expect(parts.map((part) => pieces(part).map(bodyLabels))).toEqual([[["r0", "r1"]], [["r2", "r3"]], [["r4", "r5"]]]);
  });

  it("fits each piece of a code block in a quote with the margin it shares with the quote, once", () => {
    const block = codeBlock(60);
    block.style.marginTop = "4px";
    // Measure the pieces too: the block's 28 px of chrome and the lines each holds.
    block.style.padding = "8px 0 20px";
    for (const level of [block, ...Array.from(block.querySelectorAll<HTMLElement>(".codemirror-host, .cm-editor, .cm-content"))]) {
      level.dataset.stack = "";
    }
    block.querySelector<HTMLElement>(".cm-scroller")!.dataset.row = "";
    const quote = stack("blockquote", block);
    quote.style.marginTop = "4px";
    const flow = flowWith(quote);

    // The margin, the block's chrome (28), the content's padding (8) and 23 lines take 454 px.
    splitIntoPages(flow, 454);

    const parts = Array.from(flow.children) as HTMLElement[];
    for (const part of parts) expect(part.tagName).toBe("BLOCKQUOTE");
    expect(parts.map((part) => codeLinesOf(part).length)).toEqual([23, 23, 14]);
    expect(parts.flatMap(codeLinesOf)).toEqual(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`));
  });
});
