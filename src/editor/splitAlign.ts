// Row alignment between the split's two panes (§6.1). The document view and
// the Markdown source draw the same blocks at different heights: a heading is
// taller in the document, a long paragraph usually wraps into more lines in
// the source, and frontmatter is a short disclosure in the document but
// several lines of YAML in the source. So each pane gets blank space above
// some of its blocks, until every block starts at the same height in both
// panes, and both panes end at the same height. Scrolling one pane to the
// same position as the other then shows the same blocks side by side.
//
// The work has three steps:
//
// 1. Pair blocks (`anchorsOf`). Each pane outlines its blocks: the Markdown
//    pane from CodeMirror's syntax tree, the document pane from ProseMirror's
//    document. Blocks pair in order, by kind and by the first letters of their
//    text, top-level blocks first and then the items of paired lists, the
//    blocks of paired quotes and the rows of paired tables. A block that only
//    one pane shows, such as a link reference definition, pairs with nothing.
// 2. Plan the space (`planSpacers`). Each pane reports where each paired
//    block starts without any added space. From the top down, the pane whose
//    block starts higher gets space above it. The document pane cannot take
//    space between the rows of a table, so such a pair stays unaligned and the
//    next pair aligns again.
// 3. Apply it (`SplitAlignment`). The Markdown pane takes block widgets of the
//    planned height above its lines. The document pane takes a larger top
//    margin on its blocks, set by a CSS variable that applies only while the
//    pane is aligned. Both panes keep the same content at the top of the
//    viewport while the space changes.

/** The kinds of block the panes pair by. */
export type BlockKind =
  | "frontmatter"
  | "heading"
  | "paragraph"
  | "code"
  | "math"
  | "image"
  | "html"
  | "list"
  | "item"
  | "quote"
  | "rule"
  | "table"
  | "row"
  | "footnote";

/** A block of one pane's outline. */
export interface OutlineBlock {
  kind: BlockKind;
  /** In the Markdown pane, the offset where the block's first line starts.
   *  In the document pane, the ProseMirror position before the block, or -1
   *  for the frontmatter disclosure above the document. */
  at: number;
  /** The first letters and digits of the block's text, in lower case
   *  (`textKey`), which tell blocks of the same kind apart. */
  key: string;
  /** The blocks inside a list, list item, quote or table. */
  children?: readonly OutlineBlock[];
  /** In the document pane, whether space can go in above the block. */
  spaceable?: boolean;
  /** In the document pane, whether the block starts with a line of text,
   *  which then lines up with the Markdown line's text. Otherwise the tops
   *  of the block and the line line up. */
  text?: boolean;
}

/** A pair of blocks that start at the same height once the panes align. */
export interface Anchor {
  /** The offset of the Markdown block's first line. */
  source: number;
  /** The document block's position (`OutlineBlock.at`). */
  doc: number;
  /** Whether the document pane can take space above its block. */
  spaceable: boolean;
  /** Whether the block's first line of text lines up with the Markdown
   *  line's, rather than the block's top with the line's. */
  text: boolean;
}

/** A block to measure, with where it is and whether to measure the middle of
 *  its first line of text or its top. */
export interface MeasuredBlock {
  at: number;
  text: boolean;
}

/** Space to put in above a block, in pixels. */
export interface Spacer {
  /** The block, as `OutlineBlock.at`. */
  at: number;
  height: number;
}

/** How many leading letters and digits `textKey` keeps. */
const KEY_LENGTH = 16;
/** A shorter key still pairs with a longer one it starts, from this length,
 *  such as a document item "links" with its source "[Links](https://…)". */
const MIN_PREFIX_KEY = 3;
/** The largest table `pairBlocks` fills before it pairs greedily. */
const MAX_CELLS = 1 << 20;

/** The kinds of document block that each kind of Markdown block can also
 *  become. A paragraph can be a standalone image, a one-line formula or a
 *  wrapped HTML tag. HTML can be a paragraph that holds it. */
const BECOMES: Partial<Record<BlockKind, readonly BlockKind[]>> = {
  paragraph: ["image", "math", "code", "html"],
  html: ["paragraph"],
  code: ["math"],
  math: ["code", "paragraph"],
};

/** The first letters and digits of `text`, in lower case, which pair a
 *  block of one pane with the same block of the other. */
export function textKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, KEY_LENGTH);
}

/** Whether two keys name the same text, because they are equal or one starts
 *  the other and is long enough to count. */
function sameKey(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MIN_PREFIX_KEY) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** How well a Markdown block pairs with a document block. 0 when the kinds
 *  cannot pair, otherwise higher for the same kind and for the same text. */
export function pairScore(source: OutlineBlock, doc: OutlineBlock): number {
  // A document has at most one frontmatter block.
  if (source.kind === "frontmatter" && doc.kind === "frontmatter") return BEST;
  const kind = source.kind === doc.kind ? 2 : BECOMES[source.kind]?.includes(doc.kind) ? 1 : 0;
  if (kind === 0) return 0;
  return kind + (sameKey(source.key, doc.key) ? 2 : 0);
}

/** The best score a pair can have, the same kind with the same text. */
const BEST = 4;
/** The score of blocks of kinds that can pair with the same text, which
 *  pair at the start and the end of the outlines without the table. */
const SAME_TEXT = 3;

/**
 * Pair the blocks of two outlines in order, so that the pairs score as high
 * as they can together (`pairScore`). Returns the index pairs, ascending.
 * Blocks with the same text at the start and the end pair directly, so an
 * edit leaves only the blocks around it to the table. A middle too
 * large for the table pairs greedily, looking a few blocks ahead for one
 * with the same text.
 */
export function pairBlocks(source: readonly OutlineBlock[], doc: readonly OutlineBlock[]): Array<[number, number]> {
  const head: Array<[number, number]> = [];
  let start = 0;
  while (start < source.length && start < doc.length && pairScore(source[start], doc[start]) >= SAME_TEXT) {
    head.push([start, start]);
    start += 1;
  }
  const tail: Array<[number, number]> = [];
  let endA = source.length;
  let endB = doc.length;
  while (endA > start && endB > start && pairScore(source[endA - 1], doc[endB - 1]) >= SAME_TEXT) {
    endA -= 1;
    endB -= 1;
    tail.unshift([endA, endB]);
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 || cols === 0) return [...head, ...tail];
  const middle = rows * cols <= MAX_CELLS
    ? pairByTable(source, doc, start, endA, start, endB)
    : pairGreedily(source, doc, start, endA, start, endB);
  return [...head, ...middle, ...tail];
}

/** Pair `source[fromA..toA)` with `doc[fromB..toB)` for the highest total
 *  score, like a longest common subsequence weighted by `pairScore`. */
function pairByTable(
  source: readonly OutlineBlock[],
  doc: readonly OutlineBlock[],
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
): Array<[number, number]> {
  const rows = toA - fromA;
  const cols = toB - fromB;
  const width = cols + 1;
  // best[i * width + j] is the highest score of the pairs among source[i..]
  // and doc[j..] of the middle.
  const best = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const score = pairScore(source[fromA + i], doc[fromB + j]);
      const paired = score > 0 ? score + best[(i + 1) * width + j + 1] : 0;
      best[i * width + j] = Math.max(paired, best[(i + 1) * width + j], best[i * width + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < rows && j < cols; ) {
    const score = pairScore(source[fromA + i], doc[fromB + j]);
    if (score > 0 && best[i * width + j] === score + best[(i + 1) * width + j + 1]) {
      pairs.push([fromA + i, fromB + j]);
      i++;
      j++;
    } else if (best[i * width + j] === best[(i + 1) * width + j]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** How far `pairGreedily` looks ahead for a block with the same text. */
const LOOKAHEAD = 8;

/** Pair blocks in order without a table, for outlines too long for one. A
 *  pair of the same kind and text pairs at once. Otherwise a block with the
 *  same text a few blocks ahead on either side skips the blocks before it,
 *  and failing that the two blocks pair if their kinds can. */
function pairGreedily(
  source: readonly OutlineBlock[],
  doc: readonly OutlineBlock[],
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = fromA;
  let j = fromB;
  while (i < toA && j < toB) {
    const score = pairScore(source[i], doc[j]);
    if (score < BEST) {
      const ahead = (k: number): boolean => k <= LOOKAHEAD;
      let skipA = 1;
      while (ahead(skipA) && i + skipA < toA && pairScore(source[i + skipA], doc[j]) < BEST) skipA++;
      let skipB = 1;
      while (ahead(skipB) && j + skipB < toB && pairScore(source[i], doc[j + skipB]) < BEST) skipB++;
      const foundA = ahead(skipA) && i + skipA < toA;
      const foundB = ahead(skipB) && j + skipB < toB;
      if (foundA && (!foundB || skipA <= skipB)) {
        i += skipA;
        continue;
      }
      if (foundB) {
        j += skipB;
        continue;
      }
    }
    if (score > 0) pairs.push([i, j]);
    i++;
    j++;
  }
  return pairs;
}

/**
 * The pairs of blocks that the panes align, in document order, each paired
 * block followed by the pairs among its children. A pair whose Markdown block
 * starts on the line of the pair before it, such as a list and its first
 * item, adds nothing, since it starts at the same height.
 */
export function anchorsOf(source: readonly OutlineBlock[], doc: readonly OutlineBlock[]): Anchor[] {
  const anchors: Anchor[] = [];
  const visit = (a: readonly OutlineBlock[], b: readonly OutlineBlock[]): void => {
    for (const [i, j] of pairBlocks(a, b)) {
      const s = a[i];
      const d = b[j];
      const last = anchors[anchors.length - 1];
      if (!last || (s.at > last.source && d.at > last.doc)) {
        anchors.push({ source: s.at, doc: d.at, spaceable: d.spaceable ?? false, text: d.text ?? false });
      }
      if (s.children?.length && d.children?.length) visit(s.children, d.children);
    }
  };
  visit(source, doc);
  return anchors;
}

/** Where a pair of blocks lines up in each pane without added space, in
 *  pixels from the top of the pane's content, at the middle of its first
 *  line of text or at its top (`Anchor.text`). NaN when a pane could not measure its
 *  block. */
export interface AnchorTops {
  source: number;
  doc: number;
  spaceable: boolean;
}

/** The space each pane takes, by anchor, and below its last line. */
export interface SpacerPlan {
  /** Space above each anchor's Markdown line. */
  source: number[];
  /** Space above each anchor's document block. */
  doc: number[];
  /** Space below the end of each pane. */
  sourceEnd: number;
  docEnd: number;
}

/**
 * Plan the space that makes each pair of blocks start at the same height,
 * from the top down, and both panes end at the same height. `anchors` are
 * in document order, with each pane's heights without added space. Space
 * always goes into the pane whose block starts higher. A pair that would
 * need space in the document pane where it cannot take any stays unaligned,
 * and so does one a pane could not measure, or that starts above the pair
 * before it in either pane. Heights are whole pixels.
 */
export function planSpacers(anchors: readonly AnchorTops[], ends: { source: number; doc: number }): SpacerPlan {
  const source = anchors.map(() => 0);
  const doc = anchors.map(() => 0);
  let shiftSource = 0;
  let shiftDoc = 0;
  let lastSource = -Infinity;
  let lastDoc = -Infinity;
  anchors.forEach((anchor, index) => {
    if (!Number.isFinite(anchor.source) || !Number.isFinite(anchor.doc)) return;
    if (anchor.source < lastSource || anchor.doc < lastDoc) return;
    lastSource = anchor.source;
    lastDoc = anchor.doc;
    const difference = Math.round(anchor.doc + shiftDoc - (anchor.source + shiftSource));
    if (difference > 0) {
      source[index] = difference;
      shiftSource += difference;
    } else if (difference < 0 && anchor.spaceable) {
      doc[index] = -difference;
      shiftDoc -= difference;
    }
  });
  const end = Math.round(ends.doc + shiftDoc - (ends.source + shiftSource));
  return { source, doc, sourceEnd: Math.max(0, end), docEnd: Math.max(0, -end) };
}

/**
 * Where content at `natural`, a height in a pane without added space, sits
 * once `spacers` are in. `starts` are the natural heights of the blocks the
 * spacers go above, ascending, and `heights` the space above each. Content
 * inside a block's space counts as its block's start.
 */
export function alignedHeight(natural: number, starts: readonly number[], heights: readonly number[]): number {
  let added = 0;
  for (let index = 0; index < starts.length; index++) {
    if (starts[index] > natural) break;
    added += heights[index];
  }
  return natural + added;
}

/** The inverse of `alignedHeight`, which gives the natural height of content
 *  at `aligned` in a pane with the spacers in. A height inside a spacer maps to
 *  the start of the block below it, with `above` saying how far above that
 *  block it is, and 0 elsewhere. */
export function naturalPlace(aligned: number, starts: readonly number[], heights: readonly number[]): { natural: number; above: number } {
  let added = 0;
  for (let index = 0; index < starts.length; index++) {
    const top = starts[index] + added;
    if (top > aligned) break;
    // Inside the space above this block.
    if (aligned < top + heights[index]) return { natural: starts[index], above: top + heights[index] - aligned };
    added += heights[index];
  }
  return { natural: aligned - added, above: 0 };
}

/** The natural height of content at `aligned` (`naturalPlace`). */
export function naturalHeight(aligned: number, starts: readonly number[], heights: readonly number[]): number {
  return naturalPlace(aligned, starts, heights).natural;
}

/** One pane of the split, as the alignment measures and spaces it. */
export interface AlignedPane {
  /** The pane's blocks, or null while it has none to pair. */
  outline(): readonly OutlineBlock[] | null;
  /** Where each of `blocks` lines up (`AnchorTops`), where space above it
   *  would go in (`starts`), and where the pane's content ends, without added
   *  space, in pixels from the top of the pane's scrolled content. Null while
   *  the pane cannot be measured, such as while it is hidden. */
  measure(blocks: readonly MeasuredBlock[]): { tops: number[]; starts: number[]; end: number } | null;
  /** Put space above blocks and below the end. Returns false when the pane
   *  cannot change now, such as during an input method composition. */
  setSpacers(spacers: readonly Spacer[], end: number): boolean;
  /** Take all added space out. */
  clearSpacers(): void;
  /** Call `listener` when the pane's content may have changed height.
   *  Returns a function that stops the calls. */
  onLayoutChange(listener: () => void): () => void;
}

/** What the last alignment put in, to keep the view in place when it
 *  changes and to skip work that would change nothing. */
interface Applied {
  /** The natural heights of the blocks that took space in each pane, and how
   *  much each took. */
  source: { starts: number[]; heights: number[] };
  doc: { starts: number[]; heights: number[] };
  /** The spacers as applied, compared to tell whether a new plan differs. */
  key: string;
}

/**
 * Keeps the split's panes aligned row for row while they are connected.
 * Alignment runs once per frame at most, after a change of either pane's
 * text or height, or of the panes' size. Changing the space keeps the
 * content at the top of the pane being scrolled or typed in where it was,
 * and scrolls the other pane to the same position.
 */
export class SplitAlignment {
  private doc: AlignedPane | null = null;
  private source: AlignedPane | null = null;
  private docEl: HTMLElement | null = null;
  private sourceEl: HTMLElement | null = null;
  private frame: number | null = null;
  private applied: Applied | null = null;
  /** The last pairing, for the outlines it paired. */
  private paired: { source: readonly OutlineBlock[]; doc: readonly OutlineBlock[]; anchors: Anchor[] } | null = null;
  private stops: Array<() => void> = [];

  /**
   * @param scroll Scrolls a pane for the alignment, which the scroll sync
   *   should not take for the user's scroll.
   * @param scrolling The pane the user scrolls now, if any.
   */
  constructor(
    private readonly scroll: (el: HTMLElement, top: number) => void = (el, top) => {
      el.scrollTop = top;
    },
    private readonly scrolling: () => HTMLElement | null = () => null,
  ) {}

  /** Whether the alignment holds these pane elements now. */
  isConnectedTo(docEl: HTMLElement, sourceEl: HTMLElement): boolean {
    return this.docEl === docEl && this.sourceEl === sourceEl;
  }

  /** Align `doc` in `docEl` with `source` in `sourceEl`. Idempotent for the
   *  same pair; a new pair replaces the old one, whose space is taken out. */
  connect(doc: AlignedPane, source: AlignedPane, docEl: HTMLElement, sourceEl: HTMLElement): void {
    if (this.doc === doc && this.source === source && this.docEl === docEl && this.sourceEl === sourceEl) {
      this.schedule();
      return;
    }
    this.disconnect();
    this.doc = doc;
    this.source = source;
    this.docEl = docEl;
    this.sourceEl = sourceEl;
    const schedule = (): void => this.schedule();
    this.stops.push(doc.onLayoutChange(schedule), source.onLayoutChange(schedule));
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(schedule);
      observer.observe(docEl);
      observer.observe(sourceEl);
      this.stops.push(() => observer.disconnect());
    }
    this.schedule();
  }

  /** Stop aligning and take the space out of both panes. Each pane scrolls
   *  to keep the content at its top in place, so call this while the panes
   *  still show. A hidden pane keeps its scroll position for when it shows
   *  again, which must then be where its content is without the space. */
  disconnect(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const stop of this.stops) stop();
    this.stops = [];
    const panes = [
      [this.doc, this.docEl, this.applied?.doc],
      [this.source, this.sourceEl, this.applied?.source],
    ] as const;
    for (const [pane, el, applied] of panes) {
      if (!pane || !el) continue;
      const top = el.scrollTop;
      pane.clearSpacers();
      // A view that starts in the space shows the block below at the top, as
      // that space is gone.
      if (applied?.starts.length) this.scroll(el, naturalHeight(top, applied.starts, applied.heights));
    }
    this.doc = null;
    this.source = null;
    this.docEl = null;
    this.sourceEl = null;
    this.applied = null;
    this.paired = null;
  }

  /** Align again in the next frame, for example after a mirror sync. */
  schedule(): void {
    if (!this.doc || this.frame !== null || typeof requestAnimationFrame === "undefined") return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.align();
    });
  }

  /** Align now. Pairs the blocks, measures them and puts the planned space in. */
  align(): void {
    const { doc, source, docEl, sourceEl } = this;
    if (!doc || !source || !docEl || !sourceEl) return;
    const docBlocks = doc.outline();
    const sourceBlocks = source.outline();
    if (!docBlocks || !sourceBlocks) return;
    if (this.paired?.source !== sourceBlocks || this.paired.doc !== docBlocks) {
      this.paired = { source: sourceBlocks, doc: docBlocks, anchors: anchorsOf(sourceBlocks, docBlocks) };
    }
    const { anchors } = this.paired;
    const docGeometry = doc.measure(anchors.map((anchor) => ({ at: anchor.doc, text: anchor.text })));
    const sourceGeometry = source.measure(anchors.map((anchor) => ({ at: anchor.source, text: anchor.text })));
    if (!docGeometry || !sourceGeometry) return;
    const tops = anchors.map((anchor, index) => ({
      source: sourceGeometry.tops[index],
      doc: docGeometry.tops[index],
      spaceable: anchor.spaceable,
    }));
    const plan = planSpacers(tops, { source: sourceGeometry.end, doc: docGeometry.end });
    const sourceSpacers: Spacer[] = [];
    const docSpacers: Spacer[] = [];
    const next: Applied = { source: { starts: [], heights: [] }, doc: { starts: [], heights: [] }, key: "" };
    anchors.forEach((anchor, index) => {
      if (plan.source[index] > 0) {
        sourceSpacers.push({ at: anchor.source, height: plan.source[index] });
        next.source.starts.push(sourceGeometry.starts[index]);
        next.source.heights.push(plan.source[index]);
      }
      if (plan.doc[index] > 0) {
        docSpacers.push({ at: anchor.doc, height: plan.doc[index] });
        next.doc.starts.push(docGeometry.starts[index]);
        next.doc.heights.push(plan.doc[index]);
      }
    });
    next.key = JSON.stringify([sourceSpacers, docSpacers, plan.sourceEnd, plan.docEnd]);
    if (this.applied?.key === next.key) return;

    // Keep the content at the top of the reference pane in place. Find its
    // natural height under the old space, then where it is under the new.
    const reference = this.referencePane();
    const referenceEl = reference === "doc" ? docEl : sourceEl;
    const before = this.applied?.[reference] ?? { starts: [], heights: [] };
    const place = naturalPlace(referenceEl.scrollTop, before.starts, before.heights);
    // The document pane cannot change during a composition. It reports a
    // layout change once the composition ends, which aligns again.
    if (!doc.setSpacers(docSpacers, plan.docEnd)) return;
    source.setSpacers(sourceSpacers, plan.sourceEnd);
    this.applied = next;
    const after = next[reference];
    // A view that starts in the space above a block keeps that block where it
    // was, at the same distance below the top.
    const top = Math.max(0, alignedHeight(place.natural, after.starts, after.heights) - place.above);
    this.scrollTo(referenceEl, top);
    this.scrollTo(reference === "doc" ? sourceEl : docEl, top);
  }

  /** The pane whose view stays in place, which is the one the user scrolls,
   *  else the one with focus, else the document. */
  private referencePane(): "doc" | "source" {
    const scrolling = this.scrolling();
    if (scrolling && scrolling === this.sourceEl) return "source";
    if (scrolling && scrolling === this.docEl) return "doc";
    if (this.sourceEl?.contains(document.activeElement)) return "source";
    return "doc";
  }

  /** Scroll `el` to `top` unless it is there already, so a scroll the user
   *  is making is not interrupted for nothing. */
  private scrollTo(el: HTMLElement, top: number): void {
    if (Math.abs(el.scrollTop - top) < 1) return;
    this.scroll(el, top);
  }
}
