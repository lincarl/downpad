// Writes the document view's body so that the blocks the user did not change
// keep the author's text.
//
// Milkdown writes a whole document from its ProseMirror tree, which keeps no
// source formatting. Written that way, a one-word edit rewrote tables, escapes,
// list markers and blank lines all over the file, and deleted reference link
// definitions. A SourceBaseline remembers the body Crepe parsed. To write the
// current document, it pairs the document's top-level blocks with the blocks
// of that source, writes the source text of each block Milkdown still writes
// the same way, and Milkdown's form only for blocks that changed or are new.
// The blank lines between two blocks that were neighbours in the source stay
// as they were. Link reference definitions, which the document view does not
// show, are always kept.
//
// It writes Milkdown's form of the whole document instead whenever it cannot be
// sure the result reads back as the document: when the source's blocks do not
// match the document's one for one, when two blocks written next to each other
// would read back as one (two lists, for example), or when a changed block held
// a definition.

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { RemarkParser } from "@milkdown/kit/transformer";

/** remark's syntax tree of a Markdown text. */
type MdRoot = ReturnType<RemarkParser["parse"]>;
/** The parts of a syntax tree node `holdsDefinition` reads. */
interface MdParent {
  type: string;
  children?: readonly MdParent[];
}

/** Milkdown's conversions between Markdown and the document. */
export interface MarkdownTools {
  /** Writes a document as Markdown (Milkdown's serializer). */
  serialize: (doc: ProseNode) => string;
  /** Reads Markdown without Milkdown's transforms, so every node keeps its
   *  place in the text and definitions stay in the tree. */
  parse: (markdown: string) => MdRoot;
}

/** A top-level node of the source. */
interface SourceItem {
  /** Its text, from the start of its first line, so it keeps its indent. */
  text: string;
  /** A link reference definition. The document view does not show these, so
   *  the user cannot change them there, and they are always written. */
  definition: boolean;
  /** A block with a definition inside it, which is lost if the block is rewritten. */
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
}

/** A piece of the body being written: a source item, or a block in Milkdown's
 *  form (`item` -1). */
interface Piece {
  text: string;
  item: number;
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

/** Text that holds only spaces, tabs and line breaks. */
const BLANK = /^[ \t\r\n]*$/;
/** How Milkdown separates two blocks. */
const BLANK_LINE = "\n\n";
/** The largest table `alignBlocks` fills. Larger middles are paired by position. */
const MAX_CELLS = 1 << 20;

/** The body Crepe parsed, which writes later states of the document with the
 *  source text of every top-level block that still says the same. */
export class SourceBaseline {
  /** The baseline document's top-level blocks. */
  private readonly blocks: readonly ProseNode[];
  /** Milkdown's form of each block written so far, which also serves to tell
   *  whether two blocks say the same. Nodes the user did not touch keep their
   *  identity, so each edit writes only the blocks it changed. */
  private readonly keys = new WeakMap<ProseNode, string>();
  /** The source split into its nodes, made at the first edit. Null when its
   *  blocks do not match the baseline document's. */
  private layout: SourceLayout | null | undefined;
  /** The last document written, and its Markdown. */
  private last: { doc: ProseNode; markdown: string } | null = null;
  /** Whether the pieces of a junction read back apart, keyed by the junction's
   *  text, for the junctions of this write and the one before. A write then
   *  reads back only the junctions its edit added. */
  private junctions = new Map<string, boolean>();
  private lastJunctions = new Map<string, boolean>();

  /** Remember `source` as the text Crepe just parsed into `doc`. */
  constructor(
    readonly source: string,
    doc: ProseNode,
    private readonly tools: MarkdownTools,
  ) {
    this.blocks = childrenOf(doc);
  }

  /** `doc` as Markdown. That is the exact source while the document still says
   *  the same, and otherwise the source text of each unchanged block with
   *  Milkdown's form of the rest. Milkdown's form of the whole document when
   *  the blocks cannot be paired safely. */
  write(doc: ProseNode): string {
    if (this.last?.doc !== doc) this.last = { doc, markdown: this.compose(doc) };
    return this.last.markdown;
  }

  /** Write `doc` (see `write`). */
  private compose(doc: ProseNode): string {
    const blocks = written(childrenOf(doc));
    const before = written(this.blocks);
    if (blocks.length === before.length && blocks.every((block, i) => this.same(block, before[i]))) {
      return this.source;
    }
    try {
      const markdown = this.keepUnchanged(blocks);
      if (markdown != null) return markdown;
    } catch {
      // An unexpected tree or text. Milkdown's form below is always safe.
    }
    return this.tools.serialize(doc);
  }

  /** The body with the source text of every block of `blocks` that matches a
   *  source block, or null when that cannot be written safely. */
  private keepUnchanged(blocks: readonly ProseNode[]): string | null {
    if (this.layout === undefined) this.layout = layOut(this.source, this.tools.parse(this.source), this.blocks);
    const layout = this.layout;
    if (!layout) return null;
    this.lastJunctions = this.junctions;
    this.junctions = new Map();
    const keys = blocks.map((block) => this.key(block));
    const pairs = alignBlocks(
      keys,
      layout.blockItems.map((_, i) => this.key(this.blocks[i])),
    );

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
    /** Write the definitions before source item `end`, and pass the blocks
     *  there, which the user removed or changed. False if one of those held a
     *  definition, which the rewrite would lose. */
    const passTo = (end: number): boolean => {
      for (; next < end; next++) {
        const item = layout.items[next];
        if (item.holdsDefinition) return false;
        if (item.definition && !put({ text: item.text, item: next })) return false;
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
        if (!passTo(item) || !put({ text: layout.items[item].text, item })) return null;
        next = item + 1;
        continue;
      }
      // A changed block takes the place of the next removed source block before
      // the next paired one, so definitions keep their place around it.
      let removed = next;
      while (removed < anchors[index] && layout.items[removed].definition) removed++;
      if (removed < anchors[index] && !passTo(removed + 1)) return null;
      const text = keys[index].replace(/\n$/, "");
      if (text && !put({ text, item: -1 })) return null;
    }
    if (!passTo(layout.items.length)) return null;
    return parts.length > 0 ? layout.lead + parts.join("") + layout.tail : "";
  }

  /** The text between `above` and `below`. That is the source's own when they
   *  were neighbours there. Otherwise it is the source's gap on the side of a
   *  source item, if that keeps them apart, or else a blank line. Null when
   *  neither keeps them apart. */
  private gapBetween(layout: SourceLayout, above: Piece, below: Piece): string | null {
    if (above.item >= 0 && below.item === above.item + 1) return layout.gaps[above.item];
    const near = above.item >= 0 ? layout.gaps[above.item] : below.item > 0 ? layout.gaps[below.item - 1] : undefined;
    const tries = near != null && near !== BLANK_LINE ? [near, BLANK_LINE] : [BLANK_LINE];
    return tries.find((gap) => this.separates(above.text, gap, below.text)) ?? null;
  }

  /** Whether `above` and `below`, joined by `gap`, read back as two nodes that
   *  start where they did. Two lists can merge into one, and an indented or
   *  unclosed block can take in what follows. */
  private separates(above: string, gap: string, below: string): boolean {
    const text = above + gap + below;
    const key = `${above.length}:${gap.length}:${text}`;
    let apart = this.junctions.get(key) ?? this.lastJunctions.get(key);
    if (apart === undefined) {
      const nodes = this.tools.parse(text).children;
      apart = nodes.length === 2 && (nodes[1].position?.start.offset ?? -1) >= above.length + gap.length;
    }
    this.junctions.set(key, apart);
    return apart;
  }

  /** Whether two blocks say the same, which is when Milkdown writes them the same. */
  private same(block: ProseNode, other: ProseNode): boolean {
    return block === other || this.key(block) === this.key(other);
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
 * Pairs blocks of `current` with equal blocks of `baseline`, in order. Returns,
 * for each block of `current`, the index of its pair in `baseline`, or -1 for
 * a changed or new block. Blocks that stay at the start and the end are paired
 * directly, and the rest by their longest common subsequence. When that table
 * would be too large, the rest are paired by position, which suits edits that
 * change blocks without adding or removing any, such as Replace all.
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
  if (rows === 0 || cols === 0) return pairs;

  // Number the blocks, so the table compares numbers instead of text.
  const ids = new Map<string, number>();
  const id = (key: string): number => {
    let found = ids.get(key);
    if (found === undefined) ids.set(key, (found = ids.size));
    return found;
  };
  const a = Int32Array.from({ length: rows }, (_, i) => id(current[start + i]));
  const b = Int32Array.from({ length: cols }, (_, j) => id(baseline[start + j]));
  if (rows * cols > MAX_CELLS) {
    for (let i = 0; i < Math.min(rows, cols); i++) if (a[i] === b[i]) pairs[start + i] = start + i;
    return pairs;
  }
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
 * Split `source` into its top-level nodes and pair its blocks with `blocks`,
 * the document Crepe parsed it into. Milkdown turns each top-level node except
 * a definition into one block, in order. Null when that does not hold, or when
 * text other than blank lines lies between the nodes.
 */
function layOut(source: string, tree: MdRoot, blocks: readonly ProseNode[]): SourceLayout | null {
  const items: SourceItem[] = [];
  const gaps: string[] = [];
  const blockItems: number[] = [];
  let lead = "";
  let end = 0;
  for (const node of tree.children) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from == null || to == null) return null;
    const start = source.lastIndexOf("\n", from - 1) + 1;
    const before = source.slice(end, start);
    if (start < end || !BLANK.test(before) || !BLANK.test(source.slice(start, from))) return null;
    if (items.length === 0) lead = before;
    else gaps.push(before);
    const definition = node.type === "definition";
    if (!definition) {
      const block = blocks[blockItems.length];
      if (!block || !BECOMES[node.type]?.includes(block.type.name)) return null;
      blockItems.push(items.length);
    }
    items.push({ text: source.slice(start, to), definition, holdsDefinition: !definition && holdsDefinition(node) });
    end = to;
  }
  const tail = source.slice(end);
  if (items.length === 0 || !BLANK.test(tail)) return null;
  // Crepe adds an empty paragraph below a last block that is not text, as a
  // line to type on. It has no source.
  const typingLine = blocks.length === blockItems.length + 1 && isEmptyParagraph(blocks[blocks.length - 1]);
  if (blocks.length !== blockItems.length && !typingLine) return null;
  return { lead, items, gaps, tail, blockItems };
}

/** Whether `node` holds a link reference definition at any depth. */
function holdsDefinition(node: MdParent): boolean {
  return node.children?.some((child) => child.type === "definition" || holdsDefinition(child)) ?? false;
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
