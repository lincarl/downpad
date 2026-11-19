// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  alignedHeight,
  anchorsOf,
  naturalHeight,
  naturalPlace,
  pairBlocks,
  planSpacers,
  SplitAlignment,
  textKey,
  type AlignedPane,
  type BlockKind,
  type OutlineBlock,
  type Spacer,
} from "./splitAlign";

const block = (kind: BlockKind, at: number, text = "", extra: Partial<OutlineBlock> = {}): OutlineBlock => ({ kind, at, key: textKey(text), ...extra });

describe("textKey", () => {
  it("keeps the first letters and digits in lower case", () => {
    expect(textKey("## Split *view*, alignment of rows!")).toBe("splitviewalignme");
    expect(textKey("Ünïcode 42 — ok")).toBe("ünïcode42ok");
  });
});

describe("pairBlocks", () => {
  it("pairs outlines that agree block for block", () => {
    const source = [block("heading", 0, "# Title"), block("paragraph", 10, "Text"), block("list", 20, "- item")];
    const doc = [block("heading", 1, "Title"), block("paragraph", 8, "Text"), block("list", 14, "item")];
    expect(pairBlocks(source, doc)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("leaves out a block that only one pane has, by its text", () => {
    const source = [block("paragraph", 0, "Alpha one"), block("paragraph", 10, "Beta two"), block("paragraph", 20, "Gamma three")];
    const doc = [block("paragraph", 1, "Beta two"), block("paragraph", 12, "Gamma three")];
    expect(pairBlocks(source, doc)).toEqual([[1, 0], [2, 1]]);
  });

  it("pairs kinds that a Markdown block can become, but no others", () => {
    const source = [block("paragraph", 0, "![Chart](chart.png)"), block("math", 20, "$$x$$"), block("heading", 30, "# End")];
    const doc = [block("image", 1, ""), block("math", 3, "x"), block("paragraph", 6, "End")];
    expect(pairBlocks(source, doc)).toEqual([[0, 0], [1, 1]]);
  });

  it("pairs the frontmatter and blocks with the same text directly, leaving only the rest to the table", () => {
    const source = [block("frontmatter", 0, "title: Notes"), block("paragraph", 20, "![Chart](chart.png)"), block("paragraph", 40, "New text"), block("paragraph", 50, "Kept")];
    const doc = [block("frontmatter", -1, ""), block("image", 0, "Chart"), block("paragraph", 2, "Kept")];
    expect(pairBlocks(source, doc)).toEqual([[0, 0], [1, 1], [3, 2]]);
  });

  it("pairs a document text with the longer Markdown text it starts", () => {
    const source = [block("item", 0, "- [Links](https://example.com)")];
    const doc = [block("item", 1, "Links")];
    expect(pairBlocks(source, doc)).toEqual([[0, 0]]);
  });

  it("pairs outlines too long for the table greedily, skipping a block only one pane has", () => {
    const count = 2200;
    const source = Array.from({ length: count }, (_, index) => block("paragraph", index * 10, `Number ${index} of the paragraphs`));
    // The document lacks the 6th paragraph and has a block of its own near
    // the end, so the outlines differ over more blocks than the table holds.
    const doc = source.filter((_, index) => index !== 5).map((entry, index) => ({ ...entry, at: index }));
    doc.splice(2100, 0, block("rule", 99999));
    const pairs = pairBlocks(source, doc);
    expect(pairs).toHaveLength(count - 1);
    expect(pairs[4]).toEqual([4, 4]);
    expect(pairs[5]).toEqual([6, 5]);
    expect(pairs.every(([a, b]) => source[a].key === doc[b].key)).toBe(true);
  });
});

describe("anchorsOf", () => {
  it("pairs children of paired containers and skips a child on its parent's line", () => {
    const source = [
      block("heading", 0, "# Title"),
      block("list", 10, "- one", {
        children: [block("item", 10, "- one"), block("item", 16, "- two", { children: [block("paragraph", 16, "two")] })],
      }),
    ];
    const doc = [
      block("heading", 0, "Title", { spaceable: true, text: true }),
      block("list", 7, "one", {
        spaceable: true,
        text: true,
        children: [
          block("item", 8, "one", { spaceable: false, text: true }),
          block("item", 15, "two", { spaceable: true, text: true, children: [block("paragraph", 16, "two", { spaceable: false, text: true })] }),
        ],
      }),
    ];
    expect(anchorsOf(source, doc)).toEqual([
      { source: 0, doc: 0, spaceable: true, text: true },
      { source: 10, doc: 7, spaceable: true, text: true },
      { source: 16, doc: 15, spaceable: true, text: true },
    ]);
  });
});

describe("planSpacers", () => {
  it("puts space above the Markdown line when the document block starts lower", () => {
    const plan = planSpacers(
      [
        { source: 10, doc: 40, spaceable: true },
        { source: 30, doc: 100, spaceable: true },
      ],
      { source: 50, doc: 140 },
    );
    expect(plan).toEqual({ source: [30, 40], doc: [0, 0], sourceEnd: 20, docEnd: 0 });
  });

  it("puts space above the document block when the Markdown line starts lower", () => {
    const plan = planSpacers(
      [
        { source: 10, doc: 10, spaceable: true },
        { source: 200, doc: 50, spaceable: true },
      ],
      { source: 260, doc: 100 },
    );
    expect(plan).toEqual({ source: [0, 0], doc: [0, 150], sourceEnd: 0, docEnd: 10 });
  });

  it("leaves a pair unaligned where the document takes no space, and aligns the next one", () => {
    const plan = planSpacers(
      [
        { source: 0, doc: 0, spaceable: true },
        { source: 80, doc: 40, spaceable: false },
        { source: 120, doc: 150, spaceable: true },
      ],
      { source: 140, doc: 170 },
    );
    expect(plan.source).toEqual([0, 0, 30]);
    expect(plan.doc).toEqual([0, 0, 0]);
  });

  it("skips pairs a pane could not measure or that start above the pair before", () => {
    const plan = planSpacers(
      [
        { source: 10, doc: 20, spaceable: true },
        { source: Number.NaN, doc: 60, spaceable: true },
        { source: 5, doc: 80, spaceable: true },
        { source: 40, doc: 90, spaceable: true },
      ],
      { source: 50, doc: 100 },
    );
    expect(plan.source).toEqual([10, 0, 0, 40]);
  });
});

describe("alignedHeight and naturalHeight", () => {
  const starts = [100, 300];
  const heights = [50, 20];

  it("moves content at or below each spaced block down by the space above it", () => {
    expect(alignedHeight(99, starts, heights)).toBe(99);
    expect(alignedHeight(100, starts, heights)).toBe(150);
    expect(alignedHeight(300, starts, heights)).toBe(370);
  });

  it("maps back, with heights inside a space at the block below it", () => {
    for (const natural of [0, 99, 100, 250, 300, 400]) expect(naturalHeight(alignedHeight(natural, starts, heights), starts, heights)).toBe(natural);
    expect(naturalHeight(120, starts, heights)).toBe(100);
    expect(naturalHeight(355, starts, heights)).toBe(300);
    expect(naturalPlace(120, starts, heights)).toEqual({ natural: 100, above: 30 });
    expect(naturalPlace(250, starts, heights)).toEqual({ natural: 200, above: 0 });
  });
});

/** A pane whose blocks sit at fixed natural heights, which records the
 *  space it is given. */
function fakePane(outline: OutlineBlock[], tops: Map<number, number>, end: number, element: HTMLElement) {
  const spacers: { list: readonly Spacer[]; end: number }[] = [];
  const pane: AlignedPane = {
    outline: () => outline,
    measure: (blocks) => {
      const heights = blocks.map((entry) => tops.get(entry.at) ?? Number.NaN);
      return { tops: heights, starts: heights, end };
    },
    setSpacers: (list, spaceAtEnd) => {
      spacers.push({ list, end: spaceAtEnd });
      return true;
    },
    clearSpacers: vi.fn(),
    onLayoutChange: () => () => {},
  };
  return { pane, spacers, element };
}

/** An element whose scroll position can be set, as jsdom's cannot. */
function scroller(): HTMLElement {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", { get: () => top, set: (value: number) => (top = value) });
  document.body.append(element);
  return element;
}

describe("SplitAlignment", () => {
  const sourceOutline = [block("heading", 0, "# Title"), block("paragraph", 20, "Long text")];
  const docOutline = [block("heading", 0, "Title", { spaceable: true }), block("paragraph", 7, "Long text", { spaceable: true })];

  it("puts the planned space into both panes and scrolls them together", () => {
    const docEl = scroller();
    const sourceEl = scroller();
    // The heading's line needs 90px above it. The paragraph's line then sits
    // at 210, below the document's paragraph at 200, which takes 10px.
    const doc = fakePane(docOutline, new Map([[0, 100], [7, 200]]), 400, docEl);
    const source = fakePane(sourceOutline, new Map([[0, 10], [20, 120]]), 300, sourceEl);
    const scroll = vi.fn((el: HTMLElement, top: number) => {
      el.scrollTop = top;
    });
    const alignment = new SplitAlignment(scroll);
    alignment.connect(doc.pane, source.pane, docEl, sourceEl);
    docEl.scrollTop = 50;
    alignment.align();
    expect(source.spacers.at(-1)).toEqual({ list: [{ at: 0, height: 90 }], end: 20 });
    expect(doc.spacers.at(-1)).toEqual({ list: [{ at: 7, height: 10 }], end: 0 });
    // The document keeps its place, and the Markdown pane follows it.
    expect(docEl.scrollTop).toBe(50);
    expect(sourceEl.scrollTop).toBe(50);
    expect(scroll).toHaveBeenCalledWith(sourceEl, 50);
    alignment.disconnect();
    expect(doc.pane.clearSpacers).toHaveBeenCalled();
    expect(source.pane.clearSpacers).toHaveBeenCalled();
  });

  it("scrolls each pane to keep its content in place when it takes the space out", () => {
    const docEl = scroller();
    const sourceEl = scroller();
    const doc = fakePane(docOutline, new Map([[0, 100], [7, 200]]), 400, docEl);
    const source = fakePane(sourceOutline, new Map([[0, 10], [20, 120]]), 300, sourceEl);
    const alignment = new SplitAlignment();
    alignment.connect(doc.pane, source.pane, docEl, sourceEl);
    alignment.align();
    // Both panes show the paragraph at the top: the Markdown's at 210, with
    // 90px above the heading, and the document's at 210, with 10px above it.
    docEl.scrollTop = 210;
    sourceEl.scrollTop = 210;
    expect(alignment.isConnectedTo(docEl, sourceEl)).toBe(true);
    alignment.disconnect();
    expect(alignment.isConnectedTo(docEl, sourceEl)).toBe(false);
    expect(sourceEl.scrollTop).toBe(120);
    expect(docEl.scrollTop).toBe(200);
    // Connected again, both show the paragraph at the top as before, so a
    // round trip, such as to another tab and back, does not move the view.
    alignment.connect(doc.pane, source.pane, docEl, sourceEl);
    alignment.align();
    expect(docEl.scrollTop).toBe(210);
    expect(sourceEl.scrollTop).toBe(210);
    alignment.disconnect();
  });

  it("keeps the content at the top of the focused Markdown pane in place when the space above it changes", () => {
    const docEl = scroller();
    const sourceEl = scroller();
    const docTops = new Map([[0, 100], [7, 200]]);
    const doc = fakePane(docOutline, docTops, 400, docEl);
    const source = fakePane(sourceOutline, new Map([[0, 10], [20, 120]]), 300, sourceEl);
    const focus = document.createElement("textarea");
    sourceEl.append(focus);
    focus.focus();
    const alignment = new SplitAlignment();
    alignment.connect(doc.pane, source.pane, docEl, sourceEl);
    alignment.align();
    // The Markdown pane shows its paragraph's line at the top, at 210 with
    // the 90px above the heading.
    sourceEl.scrollTop = 210;
    // The document's blocks move 40px down, so 130px go above the heading.
    docTops.set(0, 140).set(7, 240);
    alignment.align();
    expect(source.spacers.at(-1)!.list).toEqual([{ at: 0, height: 130 }]);
    expect(doc.spacers.at(-1)!.list).toEqual([{ at: 7, height: 10 }]);
    // The paragraph's line still shows at the top, and the document follows.
    expect(sourceEl.scrollTop).toBe(250);
    expect(docEl.scrollTop).toBe(250);
    alignment.disconnect();
  });

  it("changes nothing when the plan is the same", () => {
    const docEl = scroller();
    const sourceEl = scroller();
    const doc = fakePane(docOutline, new Map([[0, 100], [7, 200]]), 400, docEl);
    const source = fakePane(sourceOutline, new Map([[0, 10], [20, 120]]), 300, sourceEl);
    const alignment = new SplitAlignment();
    alignment.connect(doc.pane, source.pane, docEl, sourceEl);
    alignment.align();
    alignment.align();
    expect(doc.spacers).toHaveLength(1);
    expect(source.spacers).toHaveLength(1);
    alignment.disconnect();
  });
});
