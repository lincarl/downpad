// The document pane's part of the split's row alignment (splitAlign.ts). It
// outlines the blocks of ProseMirror's document, and puts in the blank space
// above blocks that lines them up with the Markdown pane.
//
// Space above a block is a larger top margin, set through node decorations
// as the CSS variable `--md-row-gap`. The margin replaces the gap the block
// had to the block before it, plus the planned space, so collapsing margins
// cannot swallow it. It applies only while the pane has the `md-row-aligned`
// class, which the pane drops for a moment to measure where blocks start
// without it. Space above the first block goes into the pane's top padding,
// or between the frontmatter disclosure and the document, and space after the
// end into the pane's bottom padding.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { $prose } from "@milkdown/kit/utils";
import { textKey, type AlignedPane, type BlockKind, type OutlineBlock } from "../splitAlign";

/** The class that turns the alignment's space on in the document pane. */
export const ROW_ALIGNED = "md-row-aligned";

/** The block kinds of Milkdown's nodes. A code block in LaTeX is a math block. */
const KINDS: Readonly<Record<string, BlockKind>> = {
  paragraph: "paragraph",
  heading: "heading",
  code_block: "code",
  "image-block": "image",
  bullet_list: "list",
  ordered_list: "list",
  list_item: "item",
  blockquote: "quote",
  hr: "rule",
  table: "table",
  table_header_row: "row",
  table_row: "row",
  footnote_definition: "footnote",
  html: "html",
};

/** The kinds whose child blocks pair too. */
const CONTAINERS: ReadonlySet<BlockKind> = new Set(["list", "item", "quote", "table"]);
/** The kinds that line up by their first line of text, when they have any.
 *  Code, formulas, images and rules line up by their tops, as their first
 *  line of text is not where their Markdown starts. */
const TEXT_KINDS: ReadonlySet<BlockKind> = new Set(["paragraph", "heading", "list", "item", "quote", "table", "row", "footnote"]);
/** How much of a block's text its key is read from. */
const KEY_SOURCE = 300;

/** The position of the first character of text in the node at `at`, or -1
 *  when it holds none. */
function firstText(doc: ProseNode, at: number): number {
  const node = doc.nodeAt(at);
  let found = -1;
  node?.descendants((child, pos) => {
    if (found >= 0) return false;
    if (child.isText && child.text) found = at + 1 + pos;
    return found < 0;
  });
  return found;
}

/** The kind of `node`, or null for a node that pairs with nothing. */
function kindOf(node: ProseNode): BlockKind | null {
  if (node.type.name === "code_block" && node.attrs.language === "LaTeX") return "math";
  return KINDS[node.type.name] ?? null;
}

/** The blocks among the children of `parent`, whose content starts at
 *  `start`. A block takes space above it when it follows another block of
 *  its parent, outside a table, where a top margin moves it down. The first
 *  block of the document takes it in the pane's padding instead. */
function blocksIn(parent: ProseNode, start: number, parentKind: BlockKind | null): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  parent.forEach((node, offset, index) => {
    const kind = kindOf(node);
    if (!kind) return;
    const at = start + offset;
    blocks.push({
      kind,
      at,
      // A standalone image has no text, so it goes by its alt text.
      key: textKey(kind === "image" ? String(node.attrs.alt ?? "") : node.textBetween(0, Math.min(node.content.size, KEY_SOURCE), " ", " ")),
      spaceable: parentKind !== "table" && (index > 0 || parentKind === null),
      text: TEXT_KINDS.has(kind) && node.textContent.length > 0,
      children: CONTAINERS.has(kind) ? blocksIn(node, at + 1, kind) : undefined,
    });
  });
  return blocks;
}

/** The outline of the document, with the frontmatter disclosure first when
 *  it shows, then the top-level blocks, each with the blocks it holds. Crepe's empty
 *  last line has no Markdown of its own, so it is left out. */
export function docOutline(doc: ProseNode, frontmatterShown: boolean): OutlineBlock[] {
  const blocks = blocksIn(doc, 0, null);
  const last = doc.lastChild;
  if (last?.type.name === "paragraph" && last.content.size === 0) blocks.pop();
  return frontmatterShown ? [{ kind: "frontmatter", at: -1, key: "", spaceable: true, text: true }, ...blocks] : blocks;
}

const rowSpacingKey = new PluginKey<DecorationSet>("downpadRowSpacing");

/** Draws the alignment's margins. Edits map them until the next alignment
 *  replaces them. */
export const rowSpacing = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: rowSpacingKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => tr.getMeta(rowSpacingKey) ?? set.map(tr.mapping, tr.doc),
      },
      props: { decorations: (state) => rowSpacingKey.getState(state) },
    }),
);

/** The line box of the text at `pos`, or null when there is none. */
function textLine(view: EditorView, pos: number): { top: number; bottom: number } | null {
  if (pos < 0) return null;
  try {
    return view.coordsAtPos(pos, 1);
  } catch {
    return null;
  }
}

/** The box of the first text in `element`, such as the frontmatter
 *  disclosure's label, or null when it shows none. */
function firstTextLine(element: HTMLElement): { top: number; bottom: number } | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const node = walker.nextNode();
  if (!node) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const box = range.getClientRects()[0];
  return box ? { top: box.top, bottom: box.bottom } : null;
}

/** A decoration set as a sorted list, to tell whether a new one differs. */
function describe(set: DecorationSet | undefined, doc: ProseNode): string {
  return (set?.find(0, doc.content.size) ?? []).map((decoration) => `${decoration.from}:${(decoration.spec as { gap: number }).gap}`).join(",");
}

/** The parts of the document pane the alignment needs, read when used,
 *  since the frontmatter disclosure comes and goes. */
export interface DocPaneParts {
  view: () => EditorView | null;
  /** The pane, which scrolls. */
  root: () => HTMLElement | null;
  /** The element that holds Crepe, below the disclosure. */
  body: () => HTMLElement | null;
  /** The frontmatter disclosure, when it shows. */
  frontmatter: () => HTMLElement | null;
  /** Register `listener` for changes of the pane's content height. */
  listen: (listener: () => void) => () => void;
}

/** What the pane's layout depended on when it was last measured or spaced.
 *  While it stays the same, so do the heights the blocks start at without
 *  space. */
function layoutSignature(parts: DocPaneParts, root: HTMLElement, body: HTMLElement): string {
  const frontmatter = parts.frontmatter();
  return [
    body.offsetHeight,
    frontmatter?.offsetHeight ?? -1,
    root.clientWidth,
    root.clientHeight,
    getComputedStyle(root).paddingTop,
  ].join(" ");
}

/** The document pane for `SplitAlignment`. Measuring drops the pane's space
 *  for a moment, which lays out the whole document twice. So the heights it
 *  finds are kept, and used again while the document and its layout stay the
 *  same (`layoutSignature`), such as while only the Markdown pane changes as
 *  it scrolls. */
export function docAlignedPane(parts: DocPaneParts): AlignedPane {
  /** The gap above each block that can take space, measured without it. */
  const gaps = new Map<number, number>();
  /** The heights last measured, by block, for the document and layout they
   *  were measured in. */
  let measured: { doc: ProseNode; layout: string; tops: Map<string, number>; starts: Map<string, number>; end: number } | null = null;
  const blockKey = ({ at, text }: { at: number; text: boolean }): string => `${at}${text ? "t" : "b"}`;
  let outlined: { doc: ProseNode; frontmatter: boolean; outline: OutlineBlock[] } | null = null;
  return {
    outline: () => {
      const view = parts.view();
      if (!view) return null;
      const { doc } = view.state;
      const frontmatter = parts.frontmatter() !== null;
      if (outlined?.doc !== doc || outlined.frontmatter !== frontmatter) outlined = { doc, frontmatter, outline: docOutline(doc, frontmatter) };
      return outlined.outline;
    },
    measure: (blocks) => {
      const view = parts.view();
      const root = parts.root();
      const body = parts.body();
      if (!view || !root || !body || root.clientHeight === 0) return null;
      const { doc } = view.state;
      const layout = layoutSignature(parts, root, body);
      if (measured?.doc === doc && measured.layout === layout) {
        const known = measured.tops;
        if (blocks.every((block) => known.has(blockKey(block)))) {
          const starts = measured.starts;
          return {
            tops: blocks.map((block) => known.get(blockKey(block)) ?? NaN),
            starts: blocks.map((block) => starts.get(blockKey(block)) ?? NaN),
            end: measured.end,
          };
        }
      }
      const aligned = root.classList.contains(ROW_ALIGNED);
      const scrollTop = root.scrollTop;
      const overflow = root.style.overflowY;
      // Measure without the space. The layout is put back before the
      // browser paints, and so is the scroll position, which the shorter
      // content can clamp meanwhile. The scroll bar stays as it is, since
      // the text wraps narrower beside it.
      if (aligned) {
        root.style.overflowY = root.scrollHeight > root.clientHeight ? "scroll" : "hidden";
        root.classList.remove(ROW_ALIGNED);
      }
      try {
        const origin = root.getBoundingClientRect().top - root.scrollTop;
        gaps.clear();
        // Where space above each block goes in: the pane's top padding above
        // the frontmatter disclosure or the first block, the top of the
        // document below the disclosure, and otherwise the block's top margin.
        const frontmatter = parts.frontmatter();
        const starts = blocks.map(({ at }) => {
          if (at < 0 || (at === 0 && !frontmatter)) return 0;
          if (at === 0) return body.getBoundingClientRect().top - origin;
          const element = at < doc.content.size ? view.nodeDOM(at) : null;
          return element instanceof HTMLElement ? element.getBoundingClientRect().top - origin : NaN;
        });
        const tops = blocks.map(({ at, text }) => {
          const element = at < 0 ? frontmatter : at < doc.content.size ? view.nodeDOM(at) : null;
          if (!(element instanceof HTMLElement)) return NaN;
          const top = element.getBoundingClientRect().top - origin;
          if (at > 0) {
            const $pos = doc.resolve(at);
            const before = $pos.index() > 0 ? $pos.nodeBefore : null;
            const previous = before ? view.nodeDOM(at - before.nodeSize) : null;
            if (previous instanceof HTMLElement) gaps.set(at, top - (previous.getBoundingClientRect().bottom - origin));
          }
          if (!text) return top;
          const line = at < 0 ? firstTextLine(element) : textLine(view, firstText(doc, at));
          return line ? (line.top + line.bottom) / 2 - origin : top;
        });
        const end = body.getBoundingClientRect().bottom - origin + (parseFloat(getComputedStyle(root).paddingBottom) || 0);
        measured = {
          doc,
          layout: "",
          tops: new Map(blocks.map((block, index) => [blockKey(block), tops[index]])),
          starts: new Map(blocks.map((block, index) => [blockKey(block), starts[index]])),
          end,
        };
        return { tops, starts, end };
      } finally {
        if (aligned) {
          root.classList.add(ROW_ALIGNED);
          root.style.overflowY = overflow;
          root.scrollTop = scrollTop;
        }
        // The layout as it is with the space, which the next measure compares.
        if (measured?.doc === doc) measured.layout = layoutSignature(parts, root, body);
      }
    },
    setSpacers: (spacers, end) => {
      const view = parts.view();
      const root = parts.root();
      const body = parts.body();
      if (!view || !root || !body) return true;
      // Redrawing nodes around a composition would end it.
      if (view.composing) return false;
      const { doc } = view.state;
      let top = 0;
      let afterDisclosure = 0;
      const decorations: Decoration[] = [];
      for (const spacer of spacers) {
        if (spacer.at < 0) top += spacer.height;
        else if (spacer.at === 0) {
          if (parts.frontmatter()) afterDisclosure += spacer.height;
          else top += spacer.height;
        } else {
          const gap = gaps.get(spacer.at);
          const node = spacer.at < doc.content.size ? doc.nodeAt(spacer.at) : null;
          if (gap === undefined || !node) continue;
          const margin = Math.round((gap + spacer.height) * 10) / 10;
          decorations.push(Decoration.node(spacer.at, spacer.at + node.nodeSize, { style: `--md-row-gap: ${margin}px` }, { gap: margin }));
        }
      }
      root.style.setProperty("--md-row-top", `${top}px`);
      root.style.setProperty("--md-row-end", `${end}px`);
      body.style.setProperty("--md-row-body", `${afterDisclosure}px`);
      root.classList.add(ROW_ALIGNED);
      const set = DecorationSet.create(doc, decorations);
      if (describe(set, doc) !== describe(rowSpacingKey.getState(view.state), doc)) {
        view.dispatch(view.state.tr.setMeta(rowSpacingKey, set).setMeta("addToHistory", false));
      }
      // The space changes the layout, but not where blocks start without it.
      if (measured?.doc === view.state.doc) measured.layout = layoutSignature(parts, root, body);
      return true;
    },
    clearSpacers: () => {
      measured = null;
      const root = parts.root();
      root?.classList.remove(ROW_ALIGNED);
      root?.style.removeProperty("--md-row-top");
      root?.style.removeProperty("--md-row-end");
      parts.body()?.style.removeProperty("--md-row-body");
      const view = parts.view();
      if (view && (rowSpacingKey.getState(view.state)?.find().length ?? 0) > 0) {
        view.dispatch(view.state.tr.setMeta(rowSpacingKey, DecorationSet.empty).setMeta("addToHistory", false));
      }
    },
    onLayoutChange: (listener) => parts.listen(listener),
  };
}
