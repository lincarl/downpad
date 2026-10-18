// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { packByHeight, splitIntoPages } from "./paginate";

/** jsdom does no layout, so the measurements the packer reads are stubbed. */
function block(top: number, height: number, label: string, marginTop = 0): HTMLElement {
  const el = document.createElement("div");
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
}

/**
 * A two-column table with `count` body rows, measured as if laid out: the header
 * 40px tall, each body row 100px, the columns 120/300px inside a 420px table.
 * Body rows are labelled r0..r(count-1) so a split can be checked for lost or
 * duplicated rows.
 */
function measuredTable(count: number, options: TableOptions = {}): HTMLTableElement {
  const { shape = "crepe", headColSpan = 1, tallRow } = options;
  const rowHeight = (i: number): number => (i === tallRow ? 900 : 100);
  const rowTop = (i: number): number => Array.from({ length: i }, (_, j) => rowHeight(j)).reduce((a, b) => a + b, 0);
  const table = document.createElement("table");
  Object.defineProperty(table, "offsetHeight", { value: 40 + rowTop(count) });
  Object.defineProperty(table, "offsetWidth", { value: 420 });

  const headerRow = document.createElement("tr");
  Object.defineProperty(headerRow, "offsetHeight", { value: 40 });
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
 *   the columns its text takes.
 * - `data-stack` stacks its children, each starting where the one before ends.
 * - `data-row` sets its children side by side and is as tall as the tallest.
 * - `data-height` is that many px tall.
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

  /** Where each character of `text` is laid out: words wrap, spaces hang. */
  function wrap(text: string): { line: number; column: number }[] {
    const places: { line: number; column: number }[] = [];
    let line = 0;
    let column = 0;
    for (const word of text.split(/(?<= )/)) {
      if (column > 0 && column + word.trimEnd().length > COLUMNS) {
        line++;
        column = 0;
      }
      for (let i = 0; i < word.length; i++) places.push({ line, column: column++ });
    }
    return places;
  }

  const blockOf = (node: Node): HTMLElement | null =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-text-layout]") ?? null;

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
  function linesOf(block: HTMLElement): { places: { line: number; column: number }[]; tops: number[]; heights: number[] } {
    const places = wrap(block.textContent ?? "");
    const heights = Array.from({ length: places.length ? places[places.length - 1].line + 1 : 1 }, () => LINE);
    for (const box of Array.from(block.querySelectorAll<HTMLElement>("[data-height]"))) {
      const line = places[offsetIn(block, box)].line;
      heights[line] = Math.max(heights[line], Number(box.dataset.height));
    }
    const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
    return { places, tops, heights };
  }

  const textHeight = (block: HTMLElement): number =>
    PAD * 2 + linesOf(block).heights.reduce((a, b) => a + b, 0);

  /** The fake height of `el`, or null when it carries no mark. */
  function heightOf(el: HTMLElement): number | null {
    if (el.dataset.height) return Number(el.dataset.height);
    if (el.matches("[data-text-layout]")) return textHeight(el);
    const children = Array.from(el.children) as HTMLElement[];
    if (el.matches("[data-stack]")) return children.reduce((sum, child) => sum + child.offsetHeight, 0);
    if (el.matches("[data-row]")) return Math.max(0, ...children.map((child) => child.offsetHeight));
    return null;
  }

  /** The box of `length` characters from `offset` in `block`, or of an inline box `height` px tall there. */
  function charBox(block: HTMLElement, offset: number, length: number, height?: number): DOMRect {
    const { places, tops, heights } = linesOf(block);
    const { line, column } = places[offset];
    const top = height ? PAD + tops[line] : PAD + tops[line] + heights[line] - LINE + (LINE - TEXT) / 2;
    return DOMRect.fromRect({ x: column * CHAR, y: top, width: CHAR * length, height: height ?? TEXT });
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
          let offset = parent.offsetTop;
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
          if (!block) return elementBox.call(this);
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

  const words = (from: number, to: number): string =>
    Array.from({ length: to - from }, (_, i) => `word${from + i}`).join(" ");

  /**
   * A block of 400 words with formatting that crosses where the pages break:
   * bold text, a link and two inline-code boxes.
   */
  function formattedBlock(tag: string): HTMLElement {
    const block = document.createElement(tag);
    block.dataset.textLayout = "";
    block.innerHTML =
      `${words(0, 100)} <strong class="mark">${words(100, 250)}</strong> ` +
      `<code style="display: inline-block">x=1</code> ${words(250, 262)} ` +
      `<a href="https://example.com/a" class="link">${words(262, 300)}</a> ` +
      `${words(300, 399)} <code style="display: inline-block">y=2</code>`;
    return block;
  }

  it.each([
    ["paragraph", "P"],
    ["heading", "H2"],
  ])(
    "continues a %s taller than a page between its wrapped lines, keeping its formatting",
    (_kind, tag) => {
      // A text block printed as one block, so the page body clipped everything
      // after its first page.
      const block = formattedBlock(tag);
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

  it("shrinks a block with nothing splittable in it to fit rather than letting the page cut it", () => {
    // Such a block was left as it was, and the page body cut off all of it below
    // the first page.
    const block = document.createElement("div");
    block.className = "milkdown-image-block";
    block.style.marginTop = "10px";
    Object.defineProperty(block, "offsetHeight", { value: 960 });
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
    expect(block.style.transform).toBe("scale(0.25)");
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
