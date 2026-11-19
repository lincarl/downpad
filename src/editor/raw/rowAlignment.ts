// The Markdown pane's part of the split's row alignment (splitAlign.ts). It
// outlines the blocks from CodeMirror's syntax tree, and draws the blank space
// above lines that lines it up with the document pane as block widgets. The
// space after the last line is bottom padding of the editor's content, so a
// press there still counts as one below the text, which puts the cursor at
// the end (codeMirrorPresses.ts).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { textKey, type AlignedPane, type BlockKind, type OutlineBlock, type Spacer } from "../splitAlign";

/** A node of the Markdown syntax tree. */
type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** The block kinds of Lezer's Markdown nodes, including Downpad's
 *  frontmatter and display math (markdownSource.ts). A task item's text is a
 *  `Task` node in place of its paragraph. */
const KINDS: Readonly<Record<string, BlockKind>> = {
  Frontmatter: "frontmatter",
  ATXHeading1: "heading",
  ATXHeading2: "heading",
  ATXHeading3: "heading",
  ATXHeading4: "heading",
  ATXHeading5: "heading",
  ATXHeading6: "heading",
  SetextHeading1: "heading",
  SetextHeading2: "heading",
  Paragraph: "paragraph",
  Task: "paragraph",
  FencedCode: "code",
  CodeBlock: "code",
  DisplayMath: "math",
  BulletList: "list",
  OrderedList: "list",
  ListItem: "item",
  Blockquote: "quote",
  HorizontalRule: "rule",
  Table: "table",
  TableHeader: "row",
  TableRow: "row",
  HTMLBlock: "html",
  CommentBlock: "html",
  ProcessingInstructionBlock: "html",
};

/** The kinds whose child blocks pair too. */
const CONTAINERS: ReadonlySet<BlockKind> = new Set(["list", "item", "quote", "table"]);
/** How much of a block's text its key is read from. */
const KEY_SOURCE = 300;
/** A fence line of code or math, which the document view does not show. */
const FENCE_LINE = /^[ \t>]*(?:`{3,}|~{3,}|\${2,})/;
/** The markers before a line's text: indentation, quote markers, a list
 *  marker with its task box, and a heading's hashes. */
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?/;
/** How long the outline waits for the parser to reach the end of the text. */
const PARSE_TIMEOUT_MS = 25;

/** A link or image, `[text](url)` or `![alt](url "title")`, whose text the
 *  document view shows without the rest. */
const INLINE_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/** A reference link, `[text][label]`. */
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g;
/** An autolink, `<https://…>`, which the document view shows as its URL. */
const AUTOLINK = /<((?:https?|mailto):[^>\s]*)>/g;
/** An HTML tag or comment, which the document view does not show as text. */
const HTML_TAG = /<[^>]*>/g;

/** The key of the block from `from` to `to`, made of the first letters of its
 *  text as the document view shows it (`textKey`), without fence lines, line
 *  markers, link targets and HTML tags. */
function sourceKey(state: EditorState, from: number, to: number): string {
  const text = state.doc.sliceString(from, Math.min(to, from + KEY_SOURCE));
  const lines = text.split("\n").filter((line) => !FENCE_LINE.test(line));
  const shown = lines
    .map((line) => line.replace(LINE_PREFIX, ""))
    .join(" ")
    .replace(INLINE_LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(AUTOLINK, "$1")
    .replace(HTML_TAG, " ");
  return textKey(shown);
}

/** The start of a footnote definition, `[^label]:`, which Lezer reads as a
 *  paragraph or a link reference definition. */
const FOOTNOTE = /^\[\^[^\]\s]+\]:/;

/** The kind of `node`, or null for a node that is no block of its own. A
 *  link reference definition is null, since the document view does not show
 *  it, unless it is a footnote. */
function kindOf(state: EditorState, node: SyntaxNode): BlockKind | null {
  if (node.name === "LinkReference" || node.name === "Paragraph") {
    if (FOOTNOTE.test(state.doc.sliceString(node.from, Math.min(node.to, node.from + 100)))) return "footnote";
    if (node.name === "LinkReference") return null;
  }
  return KINDS[node.name] ?? null;
}

/** The blocks among the children of `parent`. */
function blocksIn(state: EditorState, parent: SyntaxNode): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const kind = kindOf(state, node);
    if (!kind) continue;
    blocks.push({
      kind,
      at: state.doc.lineAt(node.from).from,
      key: sourceKey(state, node.from, node.to),
      children: CONTAINERS.has(kind) ? blocksIn(state, node) : undefined,
    });
  }
  return blocks;
}

/** The outline of the Markdown text, its top-level blocks each with the
 *  blocks it holds. Covers as much of the text as the parser has read, after
 *  waiting briefly for it to reach the end, and says whether it reached it. */
export function sourceOutline(state: EditorState): { outline: OutlineBlock[]; complete: boolean } {
  const complete = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS);
  return { outline: blocksIn(state, (complete ?? syntaxTree(state)).topNode), complete: complete !== null };
}

/** Blank space of a fixed height between lines. */
class Spacing extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  eq(other: Spacing): boolean {
    return other.height === this.height;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-row-spacer";
    element.setAttribute("aria-hidden", "true");
    element.style.height = `${this.height}px`;
    return element;
  }

  get estimatedHeight(): number {
    return this.height;
  }

  /** CodeMirror handles a press on the space, which puts the cursor at the
   *  start of the line below it. */
  ignoreEvent(): boolean {
    return false;
  }
}

/** Replace the spacers with these. */
const setSpacers = StateEffect.define<DecorationSet>();

/** The spacers above lines. Edits move them with the text until the next
 *  alignment replaces them. */
const spacers = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setSpacers)) return effect.value;
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The editor extension that draws the alignment's spacers. */
export function rowSpacers(): Extension {
  return spacers;
}

/** The total height of the spacers in `set` above each position of the
 *  ascending `positions`, those at a smaller position. */
function spaceAbove(set: DecorationSet, positions: readonly number[]): number[] {
  const totals: number[] = [];
  const cursor = set.iter();
  let total = 0;
  for (const pos of positions) {
    while (cursor.value && cursor.from < pos) {
      total += (cursor.value.spec.widget as Spacing).height;
      cursor.next();
    }
    totals.push(total);
  }
  return totals;
}

/** A spacer set as a sorted list, to tell whether a new one differs. */
function describe(set: DecorationSet): string {
  const parts: string[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    parts.push(`${cursor.from}:${(cursor.value.spec.widget as Spacing).height}`);
  }
  return parts.join(",");
}

/**
 * The Markdown pane for `SplitAlignment`. `pane` is the element that
 * scrolls, which holds the editor. `listen` registers a callback for each
 * editor update and returns a function that removes it.
 */
export function rawAlignedPane(
  view: () => EditorView | null,
  pane: HTMLElement,
  listen: (callback: (update: { heightChanged: boolean; geometryChanged: boolean; treeChanged: boolean }) => void) => () => void,
): AlignedPane {
  /** The space after the last line, as bottom padding of the content
   *  (`--md-row-end` in app.css). */
  let end = 0;
  /** The last outline, for the text it came from. One that covers only part
   *  of the text is made again once the parser has read more. */
  let outlined: { doc: EditorState["doc"]; tree: ReturnType<typeof syntaxTree> | null; outline: OutlineBlock[] } | null = null;
  return {
    outline: () => {
      const editor = view();
      if (!editor) return null;
      const { state } = editor;
      const tree = syntaxTree(state);
      if (outlined?.doc !== state.doc || (outlined.tree !== null && outlined.tree !== tree)) {
        const { outline, complete } = sourceOutline(state);
        outlined = { doc: state.doc, tree: complete ? null : tree, outline };
      }
      return outlined.outline;
    },
    measure: (blocks) => {
      const editor = view();
      if (!editor || pane.clientHeight === 0) return null;
      const set = editor.state.field(spacers);
      // Heights in the pane's content, from the top of what it scrolls.
      const origin = pane.getBoundingClientRect().top - pane.scrollTop;
      const top = editor.documentTop - origin;
      // A line's block starts with the spacer above the line, so only the
      // spacers before it count against the line's own height.
      // The alignment names blocks in ascending order. A block lines up by
      // the middle of its first line, or by the line's top.
      const above = spaceAbove(set, blocks.map((block) => block.at));
      const middle = editor.defaultLineHeight / 2;
      // Space goes in right above the line.
      const starts = blocks.map((block, index) => top + editor.lineBlockAt(block.at).top - above[index]);
      const tops = blocks.map((block, index) => starts[index] + (block.text ? middle : 0));
      const doc = editor.state.doc;
      // The content's own bottom padding, without the space after the end.
      const padding = (parseFloat(getComputedStyle(editor.contentDOM).paddingBottom) || 0) - end;
      const bottom = top + editor.lineBlockAt(doc.length).bottom + padding - spaceAbove(set, [doc.length + 1])[0];
      return { tops, starts, end: bottom };
    },
    setSpacers: (list, after) => {
      const editor = view();
      if (!editor) return true;
      if (after !== end) {
        end = after;
        pane.style.setProperty("--md-row-end", `${after}px`);
      }
      const builder = new RangeSetBuilder<Decoration>();
      const doc = editor.state.doc;
      // Spacers come sorted by position, each above the line it names.
      for (const spacer of [...list].sort((a: Spacer, b: Spacer) => a.at - b.at)) {
        if (spacer.at > doc.length) continue;
        builder.add(spacer.at, spacer.at, Decoration.widget({ widget: new Spacing(spacer.height), block: true, side: -1 }));
      }
      const next = builder.finish();
      if (describe(next) === describe(editor.state.field(spacers))) return true;
      editor.dispatch({ effects: setSpacers.of(next) });
      return true;
    },
    clearSpacers: () => {
      end = 0;
      pane.style.removeProperty("--md-row-end");
      const editor = view();
      if (editor && editor.state.field(spacers).size > 0) editor.dispatch({ effects: setSpacers.of(Decoration.none) });
    },
    onLayoutChange: (listener) =>
      listen((update) => {
        if (update.heightChanged || update.geometryChanged || update.treeChanged) listener();
      }),
  };
}
