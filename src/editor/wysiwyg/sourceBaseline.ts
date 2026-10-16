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
// Every place where two pieces meet that were not neighbours in the source is
// checked before the text is used. Rules that follow from how the parser ends
// each kind of block settle most of them without reading anything back. A
// blank line after a paragraph, for example, always starts a new block. Where
// the rules cannot tell, the pieces around the join are read back with Crepe's
// own parser, in a window that starts where the text above cannot change how
// it reads and ends with the first lines of the piece below. The window must
// read as exactly the pieces it holds. Each source block must be the same kind
// of node over the same text, and open the same blocks on its first line, such
// as a quote and a list in it. Each block Milkdown wrote must be the
// document's block in Milkdown's form, or read as that form reads on its own,
// as it would in Milkdown's form of the whole document.
//
// It writes Milkdown's form of the whole document instead whenever a window
// does not read back that way, even with blank lines at its joins. It also
// does so when the source's blocks do not match the document's one for one,
// when a changed block held a definition, when a new footnote could change how
// a kept block reads, when indented code could end in another place than in
// the source, or when reading the windows back would take longer than writing
// the whole document.

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { RemarkParser } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";

/** remark's syntax tree of a Markdown text. */
export type MdRoot = ReturnType<RemarkParser["parse"]>;
/** The parts of a syntax tree node the outline reads. */
interface MdNode {
  type: string;
  identifier?: string;
  children?: readonly MdNode[];
  position?: { start: { line?: number; offset?: number }; end: { offset?: number } };
}

/** Milkdown's conversions between Markdown and the document. */
export interface MarkdownTools {
  /** Writes a document as Markdown (Milkdown's serializer). */
  serialize: (doc: ProseNode) => string;
  /** Reads Markdown without Milkdown's transforms, so every node keeps its
   *  place in the text and definitions stay in the tree. */
  parse: (markdown: string) => MdRoot;
  /** Turns a tree that `parse` read from `markdown` into a document, with
   *  Milkdown's transforms, as opening a file does. May change the tree. */
  toDoc: (tree: MdRoot, markdown: string) => ProseNode;
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
  /** For a footnote definition, the label its references use. */
  footnote?: string;
  /** The labels of the definitions its links and images use. */
  uses: readonly string[];
  /** Whether a definition sits inside it, which is lost if it is rewritten. */
  holdsDefinition: boolean;
  /** The blocks its first line opens (`opens`). */
  opens: string;
}

/**
 * What ends a block, which tells what may follow it with no reading back
 * (see `apart`).
 *
 * - "line": its last line, such as a heading, a rule, a closed fence or an
 *   HTML block with its end marker on its last line.
 * - "blank": a blank line or an ATX heading, such as a paragraph, table, quote
 *   or definition.
 * - "html": only a blank line, as for an HTML block that starts with a tag.
 * - "list": a blank line and a line at column 0 that is not an item of its
 *   kind, or an ATX heading.
 * - "footnote": a blank line and a line at column 0, or an ATX heading.
 * - "indented": only an ATX heading. After indented code, the parser reads an
 *   ordered list that does not start at 1 as a paragraph, even past blank
 *   lines.
 * - "open": nothing the rules know of, such as a fence left open.
 */
export type Ending = "line" | "blank" | "html" | "list" | "footnote" | "indented" | "open";

/** A top-level node of the source. */
interface SourceItem {
  /** Its text, from the start of its first line, so it keeps its indent, to
   *  the end of its last line. */
  text: string;
  type: string;
  /** How far into its first line its node starts. */
  lead: number;
  /** For a link reference definition, its label. The document view does not
   *  show definitions, so the user cannot change them there. */
  label?: string;
  uses: readonly string[];
  holdsDefinition: boolean;
  /** The blocks its first line opens in the source (`opens`). */
  opens: string;
  /** What ends it, worked out when a join needs it (`itemEnding`). */
  ending?: Ending;
  /** Whether it read in the source as it reads at the start of a text, worked
   *  out when a join needs it (`itemFresh`). */
  fresh?: boolean;
}

/** The source body split into its top-level nodes and the blank text around them. */
interface SourceLayout {
  /** Blank lines before the first node. */
  lead: string;
  items: SourceItem[];
  /** `gaps[k]` separates `items[k]` from `items[k + 1]`, from the line break
   *  that ends `items[k]`. */
  gaps: string[];
  /** Blank text after the last node. */
  tail: string;
  /** The index in `items` of each block of the baseline document that came
   *  from the source, in order. */
  blockItems: number[];
  /** Every label a source item uses. */
  used: ReadonlySet<string>;
  /** The labels of the source's footnote definitions. */
  footnotes: ReadonlySet<string>;
}

/** A piece of the body being written, either a source item or a block in
 *  Milkdown's form (`item` -1), which then has the document `block` it stands for. */
interface Piece {
  text: string;
  item: number;
  block?: ProseNode;
  /** What ends it, worked out when a join needs it (`endingOf`). */
  ending?: Ending;
}

/** A run of joins the rules could not settle, read back together (see
 *  `join`). The pieces `first` to `last` are read in full, and the piece
 *  `head` below them by its first lines. With no full pieces, it reads back
 *  only the first lines of a source item that the rules show starts afresh,
 *  but that read another way in the source. */
interface Window {
  first: number;
  last: number;
  head: number;
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
/** The largest table `alignBlocks` fills. */
const MAX_CELLS = 1 << 20;
/** How much longer reading a character back takes than writing one, at most.
 *  Measured at 2 to 4 times for prose and lists and up to 10 times for tables
 *  in files of 34 to 343 KB. */
const PARSE_COST = 10;
/** How many characters a write may always read back. That takes a few
 *  milliseconds, so short files keep every join they can. */
const MIN_BUDGET = 2_000;
/** The syntax tree types of the blocks that hold other blocks. */
const CONTAINERS: ReadonlySet<string> = new Set(["blockquote", "list", "listItem", "footnoteDefinition"]);
/** The syntax tree and ProseMirror types of the blocks that stay open over
 *  blank lines, lists and footnotes (see `codeMayMove`). */
const STAYS_OPEN: ReadonlySet<string> = new Set(["list", "footnoteDefinition", "bullet_list", "ordered_list", "footnote_definition"]);
/** An ATX heading line. */
const ATX = /^#{1,6}(?:[ \t\n]|$)/;
/** A thematic break line. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** The opening line of a fenced code or math block. */
const FENCE = /^ {0,3}(`{3,}|~{3,}|\${2,})/;
/** How a line that can only be paragraph text starts, which is with a letter,
 *  a digit or a character no other block starts with (see `plainLine`). */
const PLAIN_START = /^[\p{L}\p{N}\\("'!&*_`~]/u;

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
  /** The blocks the first lines of each block Milkdown wrote open on their own
   *  (`headOpens`). */
  private readonly firstOpens = new WeakMap<ProseNode, string>();
  /** The source split into its nodes, made at the first edit. Null when its
   *  blocks do not match the baseline document's. */
  private layout: SourceLayout | null | undefined;
  /** The last document written, and its Markdown. */
  private last: { doc: ProseNode; markdown: string } | null = null;
  /** What reading back each window found (`reads`), keyed by its text and
   *  pieces, for the windows of this write and the one before. That is null,
   *  or the join at fault counted from the window's first piece. It only
   *  speeds up writing, because the budget is charged for every window either
   *  way. */
  private windows = new Map<string, number | null>();
  private lastWindows = new Map<string, number | null>();

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
   *  that text cannot be shown to read back as the document, or not cheaply.
   *  Throws if Milkdown cannot write the document. */
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
      if (i - from === 1 && baseTo - baseFrom === 1) {
        // One block in place of one, as typing in it leaves. One of another
        // size says something else, which tells without reading its text.
        const [block, other] = [blocks[from], before[baseFrom]];
        if (block.content.size === other.content.size && this.text(block) === this.text(other) && this.same(block, other)) {
          pairs[from] = baseFrom;
        }
      } else if (i > from && baseTo > baseFrom) {
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
    this.lastWindows = this.windows;
    this.windows = new Map();

    // A definition stays while a block that keeps its source text uses it.
    // One that nothing in the source used stays while any block keeps its
    // source text.
    const kept = pairs.filter((pair) => pair >= 0).map((pair) => layout.blockItems[pair]);
    const keptUses = new Set(kept.flatMap((item) => layout.items[item].uses));
    const keepsDefinition = (item: SourceItem): boolean =>
      kept.length > 0 && item.label !== undefined && (keptUses.has(item.label) || !layout.used.has(item.label));

    const pieces: Piece[] = [];
    /** Write source item `item`. */
    const keep = (item: number): void => {
      pieces.push({ text: layout.items[item].text, item });
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
        if (keepsDefinition(item)) keep(next);
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
        if (!passTo(item)) return null;
        keep(item);
        next = item + 1;
        continue;
      }
      // A changed block takes the place of the next removed source block before
      // the next paired one, so definitions keep their place around it.
      let removed = next;
      while (removed < anchors[index] && layout.items[removed].type === "definition") removed++;
      if (removed < anchors[index] && !passTo(removed + 1)) return null;
      const block = blocks[index];
      const text = this.key(block).replace(/\n$/, "");
      if (text) pieces.push({ text, item: -1, block });
    }
    if (!passTo(layout.items.length)) return null;
    if (pieces.length === 0) return "";
    if (addsFootnote(pieces, layout)) return null;
    const gaps = this.join(pieces, layout);
    if (!gaps) return null;
    return layout.lead + pieces.map((piece, k) => piece.text + (gaps[k] ?? "")).join("") + layout.tail;
  }

  /**
   * The text between each two of `pieces`, or null when the body cannot be
   * shown to read back as its pieces, or not cheaply.
   *
   * Two source items that were neighbours keep the source's text between
   * them. Other joins get the source's gap on the side of a source item, or a
   * blank line. The rules of `apart` settle most of them. The rest are read
   * back in windows (`reads`). When a window does not read as its pieces, the
   * join where it went wrong gets a blank line and the window is read again.
   * The budget for reading back is spent the same way whether or not a
   * window's result is cached, so a document always gets the same text.
   *
   * A window starts at the top of the body, below a join the rules settle,
   * where the parser starts afresh as it does in the window, or below a join
   * the source had. There the parser is in the state the source left, and the
   * window's first piece must still read as its source item, which shows that
   * state does not change it. A window ends with the first lines of a piece
   * whose own join below is settled or from the source, so the text after it
   * cannot change how the window reads.
   */
  private join(pieces: readonly Piece[], layout: SourceLayout): string[] | null {
    const budget = Math.max(this.source.length / PARSE_COST, MIN_BUDGET);
    const gaps: string[] = [];
    const windows: Window[] = [];
    let spent = 0;
    // The window being built, and how much of it is known so far.
    let current: Window | null = null;
    let size = 0;
    /** End the window being built with piece `lower`. */
    const end = (lower: number): void => {
      if (!current) return;
      current.head = lower;
      spent += size + headCost(pieces[lower]);
      windows.push(current);
      current = null;
      size = 0;
    };
    // A source item that depends on the text above it, at the top of the body.
    if (pieces[0].item >= 0 && !itemFresh(layout, pieces[0].item)) {
      if (codeMayMove(layout, pieces[0].item, undefined, "")) return null;
      current = { first: 0, last: -1, head: 0 };
    }
    for (let k = 0; k + 1 < pieces.length; k++) {
      const above = pieces[k];
      const below = pieces[k + 1];
      let gap: string;
      let open = false;
      let fresh = true;
      if (above.item >= 0 && below.item === above.item + 1) gap = layout.gaps[above.item];
      else {
        gap = (above.item >= 0 ? layout.gaps[above.item] : below.item > 0 ? layout.gaps[below.item - 1] : undefined) ?? BLANK_LINE;
        fresh = below.item < 0 || itemFresh(layout, below.item);
        if (below.item >= 0 && codeMayMove(layout, below.item, above, gap)) return null;
        const ending = endingOf(above, layout);
        if (!apart(ending, above.text, gap, below.text)) {
          // Read the file's gap back if that fits the budget. Otherwise a blank
          // line, if the rules show that it keeps the pieces apart.
          if (spent + size + pieceCost(above) + gap.length + headCost(below) <= budget) open = true;
          else if (apart(ending, above.text, BLANK_LINE, below.text)) gap = BLANK_LINE;
          else return null;
        }
      }
      gaps.push(gap);
      if (open) {
        current ??= { first: k, last: k - 1, head: k + 1 };
        current.last = k;
        size += pieceCost(above) + gap.length;
      } else {
        end(k);
        // The rules show the parser starts afresh here, but the source item
        // below read differently in the source, so read its first lines back.
        if (!fresh) current = { first: k + 1, last: k, head: k + 1 };
      }
    }
    end(pieces.length - 1);
    if (spent > budget) return null;

    for (const window of windows) {
      // Each join of the window gets a blank line at most once.
      for (let wrong = this.reads(window, pieces, gaps, layout); wrong !== null; wrong = this.reads(window, pieces, gaps, layout)) {
        if (wrong < window.first || gaps[wrong] === BLANK_LINE) return null;
        gaps[wrong] = BLANK_LINE;
        spent += windowCost(window, pieces, gaps);
        if (spent > budget) return null;
      }
    }
    return gaps;
  }

  /**
   * Null when `window` reads back as its pieces, joined by `gaps`. Otherwise
   * the index of the join it went wrong at. That is `window.first - 1`, the
   * join above the window, when its first piece reads wrongly from its start.
   *
   * Each source item read in full must be one node over its exact text that
   * opens the same blocks on its first line as in the source (`opens`). Each
   * block Milkdown wrote must read as that document block in Milkdown's form,
   * or as that form reads on its own (`readsAs`). The first node of the head
   * piece must start where it starts and open the blocks it opens in the
   * source, or that its first lines open on their own.
   *
   * For a node that starts where it should, micromark carries two things from
   * the text above into how it reads. One is a paragraph, definition or
   * indented code above that has not ended, as indented code has not across
   * blank lines. Then a list item that does not start at 1, or an empty one,
   * cannot start on the node's first line, even inside a quote or list that
   * starts there. Comparing the blocks the first line opens shows that. The
   * other is a lazy first line, which ends indented code after it
   * (`codeMayMove`). Every later line reads as the node's first line and its
   * own text decide, so the rest of the head piece reads as it should too.
   */
  private reads(window: Window, pieces: readonly Piece[], gaps: readonly string[], layout: SourceLayout): number | null {
    let text = "";
    const starts: number[] = [];
    const notes = new Set<string>();
    // Which source item each piece is, or the length of a block Milkdown
    // wrote, whose text decides how it should read.
    const ids: string[] = [];
    for (let k = window.first; k <= window.last; k++) {
      const piece = pieces[k];
      starts.push(text.length);
      text += piece.text + gaps[k];
      ids.push(piece.item >= 0 ? String(piece.item) : `w${piece.text.length}`);
      // A footnote reference reads as one only where its definition is, so
      // stand-ins are added below.
      piece.block?.descendants((node) => {
        if (node.type.name === "footnote_reference") notes.add(String(node.attrs.label));
      });
    }
    const lower = pieces[window.head];
    const headStart = text.length;
    const lines = head(lower.text);
    // End the head as the body goes on after it, so a container cannot take in
    // its line only because the text ends there.
    text +=
      lines +
      (lines.length < lower.text.length ? "\n" : window.head + 1 < pieces.length ? firstLine(gaps[window.head]) : layout.tail);
    ids.push(lower.item >= 0 ? String(lower.item) : "w");
    if (notes.size > 0) text += `${text.endsWith("\n") ? "" : "\n"}\n${[...notes].map((label) => `[^${label}]: .`).join("\n\n")}\n`;

    // The same window can sit further up or down in another write, so the
    // join at fault is kept as counted from the window's first piece.
    const key = `${text}\u0000${ids.join(",")}`;
    let wrong = this.windows.get(key) ?? this.lastWindows.get(key);
    if (wrong === undefined) {
      const found = this.findWrong(window, pieces, layout, text, starts, headStart);
      wrong = found === null ? null : found - window.first;
    }
    this.windows.set(key, wrong);
    return wrong === null ? null : window.first + wrong;
  }

  /** Read `text`, the text of `window` (see `reads`), and find the join where
   *  it does not read as its pieces, or null. `starts` holds where each full
   *  piece starts in it, and `headStart` where the head piece starts. */
  private findWrong(
    window: Window,
    pieces: readonly Piece[],
    layout: SourceLayout,
    text: string,
    starts: readonly number[],
    headStart: number,
  ): number | null {
    const tree = this.tools.parse(text);
    const nodes = tree.children;
    let i = 0;
    for (let k = window.first; k <= window.last; k++) {
      const piece = pieces[k];
      const start = starts[k - window.first];
      const end = start + piece.text.length;
      const own: MdRoot["children"] = [];
      while (i < nodes.length && startOf(nodes[i]) < end) own.push(nodes[i++]);
      const first = own[0];
      const last = own[own.length - 1];
      // A piece that does not start a node where it starts, or opens other
      // blocks there, was changed by the join above it. One that runs on past
      // its end took in the text below it.
      if (piece.item >= 0) {
        const item = layout.items[piece.item];
        if (!first || startOf(first) !== start + item.lead || opens(first) !== item.opens) return k - 1;
        if (own.length !== 1 || first.position?.end.offset !== end) return k;
      } else {
        if (!first || startOf(first) < start || startOf(first) > start + indentOf(piece.text)) return k - 1;
        if ((last.position?.end.offset ?? Infinity) > end) return k;
        if (!piece.block || !this.readsAs(tree, own, text, piece)) return k - 1;
      }
    }
    const lower = pieces[window.head];
    const node = nodes[i];
    const lead = leadOf(lower, layout);
    const start = node ? startOf(node) : -1;
    const fits = lead >= 0 ? start === headStart + lead : start >= headStart && start <= headStart + indentOf(lower.text);
    return node && fits && opens(node) === this.headOpens(lower, layout) ? null : window.head - 1;
  }

  /**
   * Whether `nodes`, read from `text` (`tree`), are the document block of
   * `piece` in Milkdown's form, or read as that form does on its own. The
   * second holds where Milkdown's form of a block does not read back as the
   * block, such as a paragraph that starts with a space. Writing the whole
   * body would save that block the same way.
   */
  private readsAs(tree: MdRoot, nodes: MdRoot["children"], text: string, piece: Piece): boolean {
    const { block } = piece;
    if (!block) return false;
    const read = childrenOf(this.tools.toDoc({ ...tree, children: nodes }, text));
    if (read.length === 1 && (read[0].eq(block) || this.key(read[0]) === this.key(block))) return true;
    const alone = `${piece.text}\n`;
    const own = childrenOf(this.tools.toDoc(this.tools.parse(alone), alone));
    return read.length === own.length && read.every((node, k) => this.key(node) === this.key(own[k]));
  }

  /** The blocks the first line of `piece` should open (`opens`). Those are
   *  the ones it opens in the source, or for a block Milkdown wrote, the ones
   *  it opens with its first lines on their own. */
  private headOpens(piece: Piece, layout: SourceLayout): string {
    if (piece.item >= 0) return layout.items[piece.item].opens;
    const { block } = piece;
    let found = block && this.firstOpens.get(block);
    if (found === undefined) {
      const node = this.tools.parse(`${head(piece.text)}\n`).children[0];
      found = node ? opens(node) : "";
      if (block) this.firstOpens.set(block, found);
    }
    return found;
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
      footnote: node.type === "footnoteDefinition" ? node.identifier : undefined,
      uses: [...uses],
      holdsDefinition,
      opens: opens(node),
    });
  }
  return outline;
}

/**
 * The blocks that start on the first line of `node`, outermost first, each
 * as its type and how far after `node` it starts, such as
 * "blockquote@0 list@2 listItem@2 paragraph@5 ". A quote, list, list item or
 * footnote holds the next block on its line. Text above can change which
 * blocks a line opens (see `reads`).
 */
function opens(node: MdNode): string {
  const line = node.position?.start.line;
  let found = "";
  let at: MdNode | undefined = node;
  while (at && at.position?.start.line === line) {
    found += `${at.type}@${startOf(at) - startOf(node)} `;
    at = CONTAINERS.has(at.type) ? at.children?.[0] : undefined;
  }
  return found;
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
 * Whether the parser, after reading `above`, a block that ends as `ending`,
 * and then `gap`, starts afresh on the first line of `below`, so that `above`
 * reads as it does on its own and `below` as it does at the start of a text.
 * False when only reading them back can tell. Each rule follows from how
 * micromark ends the block above (see `Ending`) and is about the line that
 * `below` starts, so it holds only with a line break in `gap`. An ATX heading
 * line starts a heading even where other blocks cannot start, and ends every
 * block except HTML and an open fence.
 */
export function apart(ending: Ending, above: string, gap: string, below: string): boolean {
  if (!gap.includes("\n")) return false;
  const blankLine = /\n[ \t]*\n/.test(gap);
  const flush = !/^[ \t]/.test(below);
  const heading = flush && ATX.test(below);
  switch (ending) {
    case "line":
      return true;
    case "blank":
      return blankLine || heading;
    case "html":
      return blankLine;
    case "list":
      // A list goes on with an item of its kind, or an indented line.
      return heading || (blankLine && flush && markerOf(below) !== markerOf(above));
    case "footnote":
      return heading || (blankLine && flush);
    case "indented":
      return heading;
    default:
      return false;
  }
}

/** What ends source item `k` (see `Ending`), worked out once. */
function itemEnding(layout: SourceLayout, k: number): Ending {
  const item = layout.items[k];
  return (item.ending ??= sourceEnding(item.type, item.text));
}

/** Whether source item `k` read in the source as it reads at the start of a
 *  text, worked out once. The first item starts the text. Each other did if
 *  the rules show the parser started afresh above it. */
function itemFresh(layout: SourceLayout, k: number): boolean {
  const item = layout.items[k];
  return (item.fresh ??= k === 0 || apart(itemEnding(layout, k - 1), layout.items[k - 1].text, layout.gaps[k - 1], item.text));
}

/**
 * Whether source item `k`, indented code below a new join under `above` (none
 * at the top of the body) and `gap`, could end in another place than it did
 * in the source. Reading back its first lines would not show that.
 *
 * Micromark ends indented code after its first line when that line is lazy,
 * which is when a list, quote or footnote above it is still open and the line
 * neither goes on with it nor starts a new one. There, code that was one block
 * splits, and code that read as two blocks only because of it joins up. The
 * code's first line was not lazy in the source if the parser started afresh
 * on it (`itemFresh`), and is not lazy here if `above` leaves nothing open. A
 * blank line closes a quote, and starts no code. Milkdown never writes
 * indented code, because it fences code and writes spaces at the start of a
 * line as character references, so only source items need this.
 */
function codeMayMove(layout: SourceLayout, k: number, above: Piece | undefined, gap: string): boolean {
  if (itemEnding(layout, k) !== "indented") return false;
  if (!itemFresh(layout, k)) return true;
  const type = above && (above.item >= 0 ? layout.items[above.item].type : above.block?.type.name);
  if (type === "blockquote") return !/\n[ \t]*\n/.test(gap);
  return type !== undefined && STAYS_OPEN.has(type);
}

/** What ends `piece` (see `Ending`), worked out once. */
function endingOf(piece: Piece, layout: SourceLayout): Ending {
  return (piece.ending ??= piece.item >= 0 ? itemEnding(layout, piece.item) : writtenEnding(piece.text));
}

/** What ends a source item of syntax tree type `type` (see `Ending`). */
function sourceEnding(type: string, text: string): Ending {
  switch (type) {
    case "heading":
    case "thematicBreak":
      return "line";
    case "code":
    case "math":
      if (closedFence(text)) return "line";
      return FENCE.test(text) ? "open" : "indented";
    case "paragraph":
    case "table":
    case "blockquote":
    case "definition":
      return "blank";
    case "html":
      return htmlEnding(text);
    case "list":
      return "list";
    case "footnoteDefinition":
      return "footnote";
    default:
      return "open";
  }
}

/**
 * What ends `text`, a block in Milkdown's form, as far as its lines show (see
 * `Ending`). Only forms the parser cannot read another way get a rule. These
 * are a one-line ATX heading or rule, a closed fence, the empty line
 * `<br />`, lines that all start a table row or a quote, paragraph lines
 * (`plainLine`), and lists and footnotes whose lines all stay inside them.
 * Anything else, such as a paragraph that starts like HTML or a setext
 * heading, is "open".
 */
export function writtenEnding(text: string): Ending {
  if (!text.includes("\n") && (ATX.test(text) || RULE.test(text))) return "line";
  if (closedFence(text)) return "line";
  if (text === "<br />") return "html";
  // Every line starts a table row, or every line a quote.
  if ((text.startsWith("|") && !/\n(?!\|)/.test(text)) || (text.startsWith(">") && !/\n(?!>)/.test(text))) return "blank";
  if (everyLine(text, plainLine)) return "blank";
  if (listLines(text)) return "list";
  // Every line after the first is blank or indented four spaces.
  if (/^\[\^[^\]\n]+\]:/.test(text) && !/\n(?!\n| {4})/.test(text)) return "footnote";
  return "open";
}

/** Whether `test` holds for every line of `text`. */
function everyLine(text: string, test: (line: string) => boolean): boolean {
  for (let start = 0; ; ) {
    const end = text.indexOf("\n", start);
    if (!test(text.slice(start, end < 0 ? text.length : end))) return false;
    if (end < 0) return true;
    start = end + 1;
  }
}

/** Whether `line` can only be text in a paragraph, wherever it is in one. */
function plainLine(line: string): boolean {
  return (
    PLAIN_START.test(line) &&
    !/^\d{1,9}[.)](?:[ \t]|$)/.test(line) &&
    !/^[*+-](?:[ \t]|$)/.test(line) &&
    !RULE.test(line) &&
    !/^(?:`{3,}|~{3,})/.test(line)
  );
}

/** Whether `text` is one list: items of its first line's kind at column 0,
 *  and other lines blank or indented at least as far as their item's text. */
function listLines(text: string): boolean {
  let marker: string | undefined;
  let size = 0;
  return everyLine(text, (line) => {
    if (line === "") return marker !== undefined;
    if (line.startsWith(" ") || line.startsWith("\t")) return marker !== undefined && line.length - line.replace(/^ +/, "").length >= size;
    // An item of the list's kind, and not a rule.
    const kind = markerOf(line);
    if (kind === undefined || (marker !== undefined && kind !== marker) || RULE.test(line)) return false;
    marker = kind;
    size = itemSize(line);
    return true;
  });
}

/** How far the text of the list item that `line` starts is indented. Infinite
 *  when tabs make that unclear. */
function itemSize(line: string): number {
  const item = /^(\d{1,9}[.)]|[*+-])([ \t]*)/.exec(line);
  if (!item || item[2].includes("\t")) return Infinity;
  const spaces = item[2].length;
  // An empty item, or one whose text is indented code, has its text one space in.
  return item[1].length + (spaces >= 1 && spaces <= 4 && line.length > item[0].length ? spaces : 1);
}

/** What ends an HTML block (see `Ending`). One that starts with `<script`,
 *  `<pre`, `<style`, `<textarea`, `<!--`, `<?`, `<!` or `<![CDATA[` ends on
 *  the line with its end marker, so it ends on its last line if the marker is
 *  there. Any other ends at a blank line. */
function htmlEnding(text: string): Ending {
  const kinds: ReadonlyArray<readonly [RegExp, RegExp]> = [
    [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
    [/^ {0,3}<!--/, /-->/],
    [/^ {0,3}<\?/, /\?>/],
    [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
    [/^ {0,3}<![A-Za-z]/, />/],
  ];
  for (const [start, end] of kinds) {
    const open = start.exec(text);
    if (!open) continue;
    // On a one-line block, the marker must come after the opener.
    return end.test(text.slice(Math.max(text.lastIndexOf("\n") + 1, open[0].length))) ? "line" : "open";
  }
  return "html";
}

/** Whether `text` is a fenced code or math block that ends with its closing
 *  fence, and only there. */
function closedFence(text: string): boolean {
  const open = FENCE.exec(text);
  if (!open) return false;
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  /** Whether `line` closes the fence that `text` opens. */
  const closes = (line: string): boolean => {
    const close = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/.exec(line);
    return !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length;
  };
  return closes(lines[lines.length - 1]) && !lines.slice(1, -1).some(closes);
}

/** The kind of list item the first line of `text` starts, which is its bullet
 *  or the delimiter after its number. Undefined when it starts none. */
function markerOf(text: string): string | undefined {
  const marker = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))(?:[ \t\n]|$)/.exec(text);
  return marker ? (marker[1] ?? marker[2]) : undefined;
}

/** The first two lines of `text`, or only the first when a blank line follows
 *  it. They decide what node starts `text` and where, because the parser looks
 *  at most one line ahead, for a setext underline or a table's delimiter row. */
function head(text: string): string {
  const first = text.indexOf("\n");
  if (first < 0) return text;
  const second = text.indexOf("\n", first + 1);
  const end = second < 0 ? text.length : second;
  return BLANK.test(text.slice(first + 1, end)) ? text.slice(0, first) : text.slice(0, end);
}

/** `text` up to and with its first line break, or all of it without one. */
function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return end < 0 ? text : text.slice(0, end + 1);
}

/** The spaces and tabs that start `text`. */
function indentOf(text: string): number {
  return text.length - text.replace(/^[ \t]+/, "").length;
}

/** How far into its first line the node of source item `piece` starts, or -1
 *  for a block Milkdown wrote. */
function leadOf(piece: Piece, layout: SourceLayout): number {
  return piece.item >= 0 ? layout.items[piece.item].lead : -1;
}

/** Where a syntax tree node starts in its text. */
function startOf(node: MdNode): number {
  return node.position?.start.offset ?? -1;
}

/** What reading `piece` in full adds to a window's cost. A block Milkdown
 *  wrote is also turned into a document and written again. */
function pieceCost(piece: Piece): number {
  return piece.text.length * (piece.item < 0 ? 2 : 1);
}

/** What reading the first lines of `piece` adds to a window's cost. */
function headCost(piece: Piece): number {
  return head(piece.text).length + 1;
}

/** What reading `window` back costs, in characters. */
function windowCost(window: Window, pieces: readonly Piece[], gaps: readonly string[]): number {
  let cost = headCost(pieces[window.head]);
  for (let k = window.first; k <= window.last; k++) cost += pieceCost(pieces[k]) + gaps[k].length;
  return cost;
}

/**
 * Whether a new footnote could change how a kept block reads. Text such as
 * `[^note]` reads as a footnote reference only where a definition with that
 * label exists. A footnote definition Milkdown wrote with a label the source
 * did not define could turn such text in a source block into a reference.
 */
function addsFootnote(pieces: readonly Piece[], layout: SourceLayout): boolean {
  const added = pieces.some(
    ({ block }) => block?.type.name === "footnote_definition" && !layout.footnotes.has(footnoteLabel(String(block.attrs.label))),
  );
  return added && pieces.some((piece) => piece.item >= 0 && piece.text.includes("[^"));
}

/** A footnote label as the parser compares it. */
function footnoteLabel(label: string): string {
  return label.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase();
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
  const footnotes = new Set<string>();
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
    if (node.footnote !== undefined) footnotes.add(footnoteLabel(node.footnote));
    // A quote or list whose last block is left open, such as a fence, ends
    // after its line break when a list or quote starts on the next line. The
    // line break goes in the gap instead, so every node's text ends on its
    // last line and every gap holds the line break before the next node.
    const text = source.slice(start, node.end).replace(/[\r\n]+$/, "");
    items.push({
      text,
      type: node.type,
      lead: node.start - start,
      label: node.label,
      uses: node.uses,
      holdsDefinition: node.holdsDefinition,
      opens: node.opens,
    });
    end = start + text.length;
  }
  const tail = source.slice(end);
  if (items.length === 0 || !BLANK.test(tail)) return null;
  // Crepe adds an empty paragraph below a last block that is not text, as a
  // line to type on. It has no source.
  const typingLine = blocks.length === blockItems.length + 1 && isEmptyParagraph(blocks[blocks.length - 1]);
  if (blocks.length !== blockItems.length && !typingLine) return null;
  return { lead, items, gaps, tail, blockItems, used, footnotes };
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
