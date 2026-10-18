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
}

/**
 * A two-column table with `count` body rows, measured as if laid out: the header
 * 40px tall, each body row 100px, the columns 120/300px inside a 420px table.
 * Body rows are labelled r0..r(count-1) so a split can be checked for lost or
 * duplicated rows.
 */
function measuredTable(count: number, options: TableOptions = {}): HTMLTableElement {
  const { shape = "crepe", headColSpan = 1 } = options;
  const table = document.createElement("table");
  Object.defineProperty(table, "offsetHeight", { value: 40 + 100 * count });
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
    Object.defineProperty(tr, "offsetTop", { value: i * 100 });
    Object.defineProperty(tr, "offsetHeight", { value: 100 });
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

  it("leaves a block with nothing splittable in it alone", () => {
    const block = document.createElement("div");
    block.className = "milkdown-code-block";
    Object.defineProperty(block, "offsetHeight", { value: 900 });
    block.textContent = "a code block the paginator cannot break";

    const flow = flowWith(block);
    splitIntoPages(flow, 250);
    // Untouched rather than mangled: one child, still the original element.
    expect(Array.from(flow.children)).toEqual([block]);
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
