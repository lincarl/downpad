// Writes the document view's body so that the blocks the user did not change
// keep the author's text.
//
// Milkdown writes a whole document from its ProseMirror tree, which keeps no
// source formatting. Written that way, a one-word edit rewrote tables, escapes,
// list markers and blank lines all over the file, and deleted reference link
// definitions. A SourceBaseline remembers the body Crepe parsed. To write the
// current document, it pairs the document's top-level blocks with the blocks
// of that source, writes the source text of each block that still says the
// same, and Milkdown's form only for blocks that changed or are new. The blank
// lines between two blocks that were neighbours in the source stay as they
// were. Link reference definitions, which the document view does not show,
// stay while a block that keeps its source text uses them.
//
// It writes Milkdown's form of the whole document instead whenever it cannot be
// sure the result reads back as the document. That is when the source's blocks
// do not match the document's one for one, when two blocks written next to
// each other would read back as one (two lists, for example), or when a changed
// block held a definition. It also does so when checking the new joins between
// blocks would take longer than writing the whole document.

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { RemarkParser } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";

/** remark's syntax tree of a Markdown text. */
type MdRoot = ReturnType<RemarkParser["parse"]>;
/** The parts of a syntax tree node the outline reads. */
interface MdNode {
  type: string;
  identifier?: string;
  children?: readonly MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Milkdown's conversions between Markdown and the document. */
export interface MarkdownTools {
  /** Writes a document as Markdown (Milkdown's serializer). */
  serialize: (doc: ProseNode) => string;
  /** Reads Markdown without Milkdown's transforms, so every node keeps its
   *  place in the text and definitions stay in the tree. */
  parse: (markdown: string) => MdRoot;
}

/** A top-level node of a Markdown text, as remark's parser read it. */
export interface OutlineNode {
  /** Its syntax tree type, such as "paragraph" or "list". */
  type: string;
  /** Where it starts and ends in the text. */
  start: number;
  end: number;
  /** For a link reference definition, the label references match it by. */
  label?: string;
  /** The labels of the definitions its links and images use. */
  uses: readonly string[];
  /** Whether a definition sits inside it, which is lost if it is rewritten. */
  holdsDefinition: boolean;
}

/** A top-level node of the source. */
interface SourceItem {
  /** Its text, from the start of its first line, so it keeps its indent. */
  text: string;
  type: string;
  /** For a link reference definition, its label. The document view does not
   *  show definitions, so the user cannot change them there. */
  label?: string;
  uses: readonly string[];
  holdsDefinition: boolean;
}

/** The source body split into its top-level nodes and the blank text around them. */
interface SourceLayout {
  /** Blank lines before the first node. */
  lead: string;
  items: SourceItem[];
  /** `gaps[k]` separates `items[k]` from `items[k + 1]`. */
  gaps: string[];
  /** Blank text after the last node. */
  tail: string;
  /** The index in `items` of each block of the baseline document that came
   *  from the source, in order. */
  blockItems: number[];
  /** Every label a source item uses. */
  used: ReadonlySet<string>;
}

/** A piece of the body being written, either a source item or a block in
 *  Milkdown's form (`item` -1). `type` is the syntax tree type it reads as. */
interface Piece {
  text: string;
  item: number;
  type: string;
}

/** The ProseMirror blocks each top-level syntax tree node can become in Crepe.
 *  A paragraph can also be a standalone image, or a formula read as a math
 *  block. HTML is wrapped in a paragraph. */
const BECOMES: Readonly<Record<string, readonly string[]>> = {
  paragraph: ["paragraph", "image-block", "code_block"],
  heading: ["heading"],
  thematicBreak: ["hr"],
  blockquote: ["blockquote"],
  list: ["bullet_list", "ordered_list"],
  code: ["code_block"],
  math: ["code_block"],
  html: ["paragraph"],
  table: ["table"],
  footnoteDefinition: ["footnote_definition"],
};

/** The syntax tree node Milkdown writes each kind of top-level block as. */
const WRITTEN_AS: Readonly<Record<string, string>> = {
  paragraph: "paragraph",
  "image-block": "paragraph",
  heading: "heading",
  hr: "thematicBreak",
  blockquote: "blockquote",
  bullet_list: "list",
  ordered_list: "list",
  code_block: "code",
  table: "table",
  footnote_definition: "footnoteDefinition",
};

/** Text that holds only spaces, tabs and line breaks. */
const BLANK = /^[ \t\r\n]*$/;
/** How Milkdown separates two blocks. */
const BLANK_LINE = "\n\n";
/** The largest table `alignBlocks` fills. */
const MAX_CELLS = 1 << 20;
/** How much longer remark takes to read a character than Milkdown takes to
 *  write one. Measured at 2 to 4 times on files of 34 to 343 KB. */
const PARSE_COST = 3;
/** How many characters a write may always read back. That takes a few
 *  milliseconds, so short files keep every join they can. */
const MIN_BUDGET = 2_000;

/** The body Crepe parsed, which writes later states of the document with the
 *  source text of every top-level block that still says the same. */
export class SourceBaseline {
  /** The baseline document's top-level blocks. */
  private readonly blocks: readonly ProseNode[];
  /** The index of each baseline block. Blocks the user did not touch stay the
   *  same nodes, so most blocks pair without being written. */
  private index: Map<ProseNode, number> | null = null;
  /** Milkdown's form of each block written so far, ending in a line break. */
  private readonly keys = new WeakMap<ProseNode, string>();
  /** Each compared block's type and text, which differ when blocks differ. */
  private readonly texts = new WeakMap<ProseNode, string>();
  /** The source split into its nodes, made at the first edit. Null when its
   *  blocks do not match the baseline document's. */
  private layout: SourceLayout | null | undefined;
  /** The last document written, and its Markdown. */
  private last: { doc: ProseNode; markdown: string } | null = null;
  /** Whether the pieces of a junction read back apart, keyed by the text read,
   *  for the junctions of this write and the one before. A write then reads
   *  back only the junctions its edit added. */
  private junctions = new Map<string, boolean>();
  private lastJunctions = new Map<string, boolean>();
  /** How many characters this write may still read back before that costs
   *  more than writing the whole document. */
  private budget = 0;

  /**
   * Remember `source` as the text Crepe just parsed into `doc`. `outline` is
   * the outline of that parse, if it was captured (`outlinePlugin`). Without
   * it, the source is parsed again at the first edit.
   */
  constructor(
    readonly source: string,
    doc: ProseNode,
    private readonly tools: MarkdownTools,
    private outline?: readonly OutlineNode[] | null,
  ) {
    this.blocks = childrenOf(doc);
  }

  /** `doc` as Markdown. That is the exact source while the document still says
   *  the same, and otherwise the source text of each unchanged block with
   *  Milkdown's form of the rest. Milkdown's form of the whole document when
   *  the blocks cannot be kept apart safely or cheaply. Throws if Milkdown
   *  cannot write the document. */
  write(doc: ProseNode): string {
    if (this.last?.doc !== doc) this.last = { doc, markdown: this.compose(doc) };
    return this.last.markdown;
  }

  /** Write `doc` (see `write`). */
  private compose(doc: ProseNode): string {
    const blocks = written(childrenOf(doc));
    const before = written(this.blocks);
    try {
      const pairs = this.pair(blocks, before);
      if (blocks.length === before.length && pairs.every((pair, i) => pair === i)) return this.source;
      const markdown = this.keepUnchanged(blocks, pairs);
      if (markdown != null) return markdown;
    } catch {
      // An unexpected tree or text, or a block Milkdown cannot write. Milkdown's
      // form of the whole document below is always safe.
    }
    return this.tools.serialize(doc);
  }

  /**
   * For each block of `blocks`, the index of the block of `before` it pairs
   * with, or -1 for a changed or new block. Blocks the user did not touch are
   * the same nodes as in the baseline and pair first. The blocks between two
   * of those pair by what they say, as `alignBlocks` pairs them.
   */
  private pair(blocks: readonly ProseNode[], before: readonly ProseNode[]): number[] {
    const index = (this.index ??= new Map(this.blocks.map((block, i) => [block, i])));
    const pairs = increasingRun(
      blocks.map((block) => {
        const at = index.get(block);
        return at !== undefined && at < before.length ? at : -1;
      }),
    );
    let from = 0;
    let baseFrom = 0;
    for (let i = 0; i <= blocks.length; i++) {
      if (i < blocks.length && pairs[i] < 0) continue;
      const baseTo = i < blocks.length ? pairs[i] : before.length;
      if (i > from && baseTo > baseFrom) {
        const current = blocks.slice(from, i);
        const baseline = before.slice(baseFrom, baseTo);
        const found = alignBlocks(
          current.map((block) => this.text(block)),
          baseline.map((block) => this.text(block)),
        );
        for (const [k, pair] of found.entries()) {
          if (pair >= 0 && this.same(current[k], baseline[pair])) pairs[from + k] = baseFrom + pair;
        }
      }
      from = i + 1;
      baseFrom = baseTo + 1;
    }
    return pairs;
  }

  /** The body with the source text of every block of `blocks` paired with a
   *  source block (`pairs`), or null when that cannot be written safely. */
  private keepUnchanged(blocks: readonly ProseNode[], pairs: readonly number[]): string | null {
    const layout = this.sourceLayout();
    if (!layout) return null;
    this.lastJunctions = this.junctions;
    this.junctions = new Map();
    this.budget = Math.max(this.source.length / PARSE_COST, MIN_BUDGET);

    // A definition stays while a block that keeps its source text uses it.
    // One that nothing in the source used stays while any block keeps its
    // source text.
    const kept = pairs.filter((pair) => pair >= 0).map((pair) => layout.blockItems[pair]);
    const keptUses = new Set(kept.flatMap((item) => layout.items[item].uses));
    const keepsDefinition = (item: SourceItem): boolean =>
      kept.length > 0 && item.label !== undefined && (keptUses.has(item.label) || !layout.used.has(item.label));

    const parts: string[] = [];
    let above: Piece | null = null;
    /** Write `piece` below the last one. False if no gap keeps them apart. */
    const put = (piece: Piece): boolean => {
      if (above) {
        const gap = this.gapBetween(layout, above, piece);
        if (gap == null) return false;
        parts.push(gap);
      }
      parts.push(piece.text);
      above = piece;
      return true;
    };
    // The first source item not written or passed yet.
    let next = 0;
    /** Write the definitions that stay before source item `end`, and pass the
     *  rest there. False if a block there held a definition, which the rewrite
     *  of that block would lose. */
    const passTo = (end: number): boolean => {
      for (; next < end; next++) {
        const item = layout.items[next];
        if (item.holdsDefinition) return false;
        if (keepsDefinition(item) && !put({ text: item.text, item: next, type: item.type })) return false;
      }
      return true;
    };

    // For each block, the source item of the next block paired with the source.
    const anchors: number[] = [];
    for (let index = pairs.length - 1, at = layout.items.length; index >= 0; index--) {
      if (pairs[index] >= 0) at = layout.blockItems[pairs[index]];
      anchors[index] = at;
    }
    for (const [index, pair] of pairs.entries()) {
      if (pair >= 0) {
        const item = layout.blockItems[pair];
        const { text, type } = layout.items[item];
        if (!passTo(item) || !put({ text, item, type })) return null;
        next = item + 1;
        continue;
      }
      // A changed block takes the place of the next removed source block before
      // the next paired one, so definitions keep their place around it.
      let removed = next;
      while (removed < anchors[index] && layout.items[removed].type === "definition") removed++;
      if (removed < anchors[index] && !passTo(removed + 1)) return null;
      const text = this.key(blocks[index]).replace(/\n$/, "");
      if (text && !put({ text, item: -1, type: WRITTEN_AS[blocks[index].type.name] ?? "" })) return null;
    }
    if (!passTo(layout.items.length)) return null;
    return parts.length > 0 ? layout.lead + parts.join("") + layout.tail : "";
  }

  /** The source split into its nodes, made once. Null when it cannot be. */
  private sourceLayout(): SourceLayout | null {
    if (this.layout === undefined) {
      try {
        this.outline ??= outlineOf(this.tools.parse(this.source));
        this.layout = this.outline && layOut(this.source, this.outline, this.blocks);
      } catch {
        this.layout = null;
      }
      this.outline = null;
    }
    return this.layout;
  }

  /** The text between `above` and `below`. That is the source's own when they
   *  were neighbours there. Otherwise it is the source's gap on the side of a
   *  source item, if that keeps them apart, or else a blank line. Null when
   *  neither keeps them apart, or when telling would take too long. */
  private gapBetween(layout: SourceLayout, above: Piece, below: Piece): string | null {
    if (above.item >= 0 && below.item === above.item + 1) return layout.gaps[above.item];
    const near = above.item >= 0 ? layout.gaps[above.item] : below.item > 0 ? layout.gaps[below.item - 1] : undefined;
    const tries = near != null && near !== BLANK_LINE ? [near, BLANK_LINE] : [BLANK_LINE];
    return tries.find((gap) => startsApart(above, gap, below) ?? this.readsApart(above.text, gap, below.text)) ?? null;
  }

  /** Whether `above` and `below`, joined by `gap`, read back as two nodes, the
   *  second starting where `below` starts (after its own indent). Only the
   *  first lines of `below` are read, which decide that. Undefined when this
   *  write has no budget left for reading them. */
  private readsApart(above: string, gap: string, below: string): boolean | undefined {
    const boundary = above.length + gap.length;
    const text = above + gap + head(below);
    const key = `${boundary}:${text}`;
    let apart = this.junctions.get(key) ?? this.lastJunctions.get(key);
    if (apart === undefined) {
      if (text.length > this.budget) return undefined;
      this.budget -= text.length;
      const nodes = this.tools.parse(text).children;
      const start = nodes[1]?.position?.start.offset ?? -1;
      const indent = below.length - below.replace(/^[ \t]+/, "").length;
      apart = nodes.length === 2 && start >= boundary && start <= boundary + indent;
    }
    this.junctions.set(key, apart);
    return apart;
  }

  /** Whether two blocks say the same, which is when Milkdown writes them the
   *  same. The checks that need no writing come first. */
  private same(block: ProseNode, other: ProseNode): boolean {
    return block === other || block.eq(other) || this.key(block) === this.key(other);
  }

  /** `block`'s type and text, which tell most different blocks apart without
   *  writing them. Blocks Milkdown writes the same have the same. */
  private text(block: ProseNode): string {
    let text = this.texts.get(block);
    if (text === undefined) {
      text = `${block.type.name}\n${block.textContent}`;
      this.texts.set(block, text);
    }
    return text;
  }

  /** Milkdown's form of `block` on its own, ending in a line break. */
  private key(block: ProseNode): string {
    let key = this.keys.get(block);
    if (key === undefined) {
      // Milkdown leaves out an empty last paragraph. Written twice, the first
      // one gets the form it has between other blocks.
      key = this.tools.serialize(block.type.schema.topNodeType.create(null, isEmptyParagraph(block) ? [block, block] : [block]));
      this.keys.set(block, key);
    }
    return key;
  }
}

/**
 * A Milkdown plugin that reports the outline of each text Crepe's remark parser
 * reads (`outlineOf`), taken before Milkdown's transforms change the tree.
 * With it, the first edit does not have to parse the source a second time.
 */
export function outlinePlugin(report: (text: string, outline: readonly OutlineNode[] | null) => void) {
  return $remark("mdEasyOutline", () =>
    function () {
      const parse = this.parser;
      if (!parse) return;
      this.parser = (text, file) => {
        const tree = parse(text, file);
        report(text, outlineOf(tree));
        return tree;
      };
    },
  );
}

/** The top-level nodes of `tree`, or null when one has no position. */
export function outlineOf(tree: MdNode): OutlineNode[] | null {
  const outline: OutlineNode[] = [];
  for (const node of tree.children ?? []) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start == null || end == null) return null;
    const uses = new Set<string>();
    let holdsDefinition = false;
    // Definitions and references sit at any depth below a container.
    const visit = (parent: MdNode): void => {
      for (const child of parent.children ?? []) {
        if (child.type === "definition") holdsDefinition = true;
        else if ((child.type === "linkReference" || child.type === "imageReference") && child.identifier) uses.add(child.identifier);
        visit(child);
      }
    };
    visit(node);
    outline.push({
      type: node.type,
      start,
      end,
      label: node.type === "definition" ? node.identifier : undefined,
      uses: [...uses],
      holdsDefinition,
    });
  }
  return outline;
}

/**
 * Pairs blocks of `current` with equal blocks of `baseline`, in order. Returns,
 * for each block of `current`, the index of its pair in `baseline`, or -1 for
 * a changed or new block. Blocks that stay at the start and the end are paired
 * directly, and the rest by their longest common subsequence. When that table
 * would be too large, the rest stay unpaired.
 */
export function alignBlocks(current: readonly string[], baseline: readonly string[]): number[] {
  const pairs = current.map(() => -1);
  let start = 0;
  while (start < current.length && start < baseline.length && current[start] === baseline[start]) {
    pairs[start] = start;
    start++;
  }
  let end = current.length;
  let baseEnd = baseline.length;
  while (end > start && baseEnd > start && current[end - 1] === baseline[baseEnd - 1]) pairs[--end] = --baseEnd;
  const rows = end - start;
  const cols = baseEnd - start;
  if (rows === 0 || cols === 0 || rows * cols > MAX_CELLS) return pairs;

  // Number the blocks, so the table compares numbers instead of text.
  const ids = new Map<string, number>();
  const id = (key: string): number => {
    let found = ids.get(key);
    if (found === undefined) ids.set(key, (found = ids.size));
    return found;
  };
  const a = Int32Array.from({ length: rows }, (_, i) => id(current[start + i]));
  const b = Int32Array.from({ length: cols }, (_, j) => id(baseline[start + j]));
  // lcs[i * width + j] is the length of the longest common subsequence of
  // a[i..] and b[j..].
  const width = cols + 1;
  const lcs = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < rows && j < cols; ) {
    if (a[i] === b[j]) pairs[start + i++] = start + j++;
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * `found` with only its longest increasing run of indices kept, and -1 for the
 * rest. Entries of -1 are skipped. When the user moves a block, this keeps the
 * blocks around it in their order and leaves the moved one out.
 */
export function increasingRun(found: readonly number[]): number[] {
  // tails[n] is the position in `found` of the smallest last index of a run of
  // n + 1, and before[k] the position of the entry before `found[k]` in its run.
  const tails: number[] = [];
  const before = new Int32Array(found.length).fill(-1);
  for (const [k, value] of found.entries()) {
    if (value < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (found[tails[middle]] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) before[k] = tails[low - 1];
    tails[low] = k;
  }
  const run = found.map(() => -1);
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = before[k]) run[k] = found[k];
  return run;
}

/**
 * Whether `below` starts a node of its own on its first line after `above`
 * and `gap`, as far as the kind of each piece tells. Undefined when only
 * reading them back can tell.
 *
 * A heading, a rule or a closed fence ends on its last line. A blank line ends
 * a paragraph, table, quote or definition. A list, footnote or indented code
 * also needs the next line to start at column 0, and a list goes on when that
 * line is an item of its kind. An ATX heading at column 0 ends all of these.
 */
function startsApart(above: Piece, gap: string, below: Piece): boolean | undefined {
  const blankLine = /\n[ \t]*\n/.test(gap);
  const flush = !/^[ \t]/.test(below.text);
  const heading = flush && /^#{1,6}(?:[ \t\n]|$)/.test(below.text);
  switch (ending(above)) {
    case "line":
      return true;
    case "blank":
      return blankLine || heading || undefined;
    case "flush":
      if (heading) return true;
      if (!blankLine || !flush) return undefined;
      if (above.type !== "list" || markerOf(below.text) !== markerOf(above.text)) return true;
      // Below a list, a list with the same kind of marker is more of its items.
      return below.type === "list" ? false : undefined;
    default:
      return undefined;
  }
}

/** What ends a piece (see `startsApart`). An HTML block or an open fence can
 *  run on past blank lines, so only a read-back tells. */
function ending({ type, text }: Piece): "line" | "blank" | "flush" | "open" {
  switch (type) {
    case "heading":
    case "thematicBreak":
      return "line";
    case "code":
    case "math":
      if (closedFence(text)) return "line";
      return /^ {0,3}(?:`{3}|~{3}|\${2})/.test(text) ? "open" : "flush";
    case "paragraph":
      // Written Markdown that starts like HTML or math could open a block.
      return /^[<$]/.test(text) ? "open" : "blank";
    case "table":
    case "blockquote":
    case "definition":
      return "blank";
    case "list":
    case "footnoteDefinition":
      return "flush";
    default:
      return "open";
  }
}

/** Whether `text` is a fenced code or math block that ends with its closing fence. */
function closedFence(text: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,}|\${2,})/.exec(text);
  const last = text.lastIndexOf("\n");
  if (!open || last < 0) return false;
  const close = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/.exec(text.slice(last + 1));
  return !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length;
}

/** The kind of list item the first line of `text` starts, which is its bullet
 *  or the delimiter after its number. Undefined when it starts none. */
function markerOf(text: string): string | undefined {
  const marker = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))(?:[ \t\n]|$)/.exec(text);
  return marker ? (marker[1] ?? marker[2]) : undefined;
}

/** The first two lines of `text`, or only the first when a blank line follows
 *  it. They decide where a block that starts `text` starts, because the parser
 *  looks at most one line ahead, for a setext underline or a table's delimiter
 *  row. */
function head(text: string): string {
  const first = text.indexOf("\n");
  if (first < 0) return text;
  const second = text.indexOf("\n", first + 1);
  const end = second < 0 ? text.length : second;
  return BLANK.test(text.slice(first + 1, end)) ? text.slice(0, first) : text.slice(0, end);
}

/**
 * Split `source` into its top-level nodes (`outline`) and pair its blocks with
 * `blocks`, the document Crepe parsed it into. Milkdown turns each top-level
 * node except a definition into one block, in order. Null when that does not
 * hold, or when text other than blank lines lies between the nodes.
 */
function layOut(source: string, outline: readonly OutlineNode[], blocks: readonly ProseNode[]): SourceLayout | null {
  const items: SourceItem[] = [];
  const gaps: string[] = [];
  const blockItems: number[] = [];
  const used = new Set<string>();
  let lead = "";
  let end = 0;
  for (const node of outline) {
    const start = source.lastIndexOf("\n", node.start - 1) + 1;
    const before = source.slice(end, start);
    if (start < end || !BLANK.test(before) || !BLANK.test(source.slice(start, node.start))) return null;
    if (items.length === 0) lead = before;
    else gaps.push(before);
    if (node.type !== "definition") {
      const block = blocks[blockItems.length];
      if (!block || !BECOMES[node.type]?.includes(block.type.name)) return null;
      blockItems.push(items.length);
    }
    for (const label of node.uses) used.add(label);
    items.push({
      text: source.slice(start, node.end),
      type: node.type,
      label: node.label,
      uses: node.uses,
      holdsDefinition: node.holdsDefinition,
    });
    end = node.end;
  }
  const tail = source.slice(end);
  if (items.length === 0 || !BLANK.test(tail)) return null;
  // Crepe adds an empty paragraph below a last block that is not text, as a
  // line to type on. It has no source.
  const typingLine = blocks.length === blockItems.length + 1 && isEmptyParagraph(blocks[blocks.length - 1]);
  if (blocks.length !== blockItems.length && !typingLine) return null;
  return { lead, items, gaps, tail, blockItems, used };
}

/** The top-level blocks of `doc`. */
function childrenOf(doc: ProseNode): ProseNode[] {
  const children: ProseNode[] = [];
  doc.forEach((child) => children.push(child));
  return children;
}

/** `blocks` without an empty last paragraph, which Milkdown leaves out because
 *  it is the line Crepe keeps to type on. */
function written(blocks: readonly ProseNode[]): readonly ProseNode[] {
  const last = blocks[blocks.length - 1];
  return last && isEmptyParagraph(last) ? blocks.slice(0, -1) : blocks;
}

/** Whether `node` is a paragraph with nothing in it. */
function isEmptyParagraph(node: ProseNode): boolean {
  return node.type.name === "paragraph" && node.content.size === 0;
}
