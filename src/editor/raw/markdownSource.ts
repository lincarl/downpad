// The Markdown view's language, syntax colours, selection colours and find
// highlights. Token colours follow VS Code's default Markdown theming (Light+
// and Dark+, which Light Modern and Dark Modern build on). app.css supplies
// them per document theme as `--md-src-*` variables.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { getSearchQuery } from "@codemirror/search";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { Tag, styleTags, tags as t } from "@lezer/highlight";
import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";

/** Nodes that VS Code colours apart from the tags Lezer gives them. */
const md = {
  inlineCode: Tag.define(),
  listMark: Tag.define(),
  quoteMark: Tag.define(),
  /** Image alt text keeps the body colour, unlike link text. */
  image: Tag.define(),
  /** Table header cells are plain text in VS Code, not headings. */
  tableHeader: Tag.define(),
  frontmatterKey: Tag.define(),
  frontmatterValue: Tag.define(),
};

const FRONTMATTER_DELIMITER = /^---[ \t]*$/;
/** A closing `---` or `...` line. Multiline so it also finds one in later text. */
const FRONTMATTER_CLOSE = /^(---|\.\.\.)[ \t]*$/m;
/** `key: value` or `- key: value`; the key may not start with `#` or `:`. */
const YAML_KEY = /^([ \t]*(?:-[ \t]+)?)([^\s#:][^:]*?):(?=[ \t]|$)/;
const YAML_LIST_ITEM = /^([ \t]*-[ \t]+)/;

/** The key, value and comment nodes of one frontmatter line. */
function frontmatterLine(cx: BlockContext, start: number, text: string): Element[] {
  const trimmedEnd = text.trimEnd().length;
  if (/^[ \t]*#/.test(text)) {
    return [cx.elt("FrontmatterComment", start + text.search(/#/), start + trimmedEnd)];
  }
  const key = YAML_KEY.exec(text);
  const valueFrom = key ? key[0].length : (YAML_LIST_ITEM.exec(text)?.[1].length ?? 0);
  const elements = key
    ? [cx.elt("FrontmatterKey", start + key[1].length, start + key[1].length + key[2].length)]
    : [];
  const valueStart = valueFrom + (text.slice(valueFrom).length - text.slice(valueFrom).trimStart().length);
  if (valueStart < trimmedEnd) {
    elements.push(cx.elt("FrontmatterValue", start + valueStart, start + trimmedEnd));
  }
  return elements;
}

/**
 * Whether a closing `---` or `...` line follows `from`. Without one,
 * `splitFrontmatter` finds no frontmatter and the document view reads the text
 * as Markdown. Lezer keeps the parse input on the context but leaves it out of
 * its types. If a later version drops it, an unclosed block reads as
 * frontmatter again.
 */
function frontmatterCloses(cx: BlockContext, from: number): boolean {
  const { input } = cx as BlockContext & {
    readonly input?: { readonly length: number; read(from: number, to: number): string };
  };
  return input ? FRONTMATTER_CLOSE.test(input.read(from, input.length)) : true;
}

/**
 * A leading `---` block parsed as YAML frontmatter (spec §5.17), so its keys
 * and values get VS Code's YAML colours instead of reading as a horizontal rule
 * and a Setext heading. As in `splitFrontmatter`, the block ends at the first
 * `---` or `...` line and needs one to count as frontmatter.
 */
const frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true },
    "FrontmatterMark",
    { name: "FrontmatterKey", style: md.frontmatterKey },
    { name: "FrontmatterValue", style: md.frontmatterValue },
    { name: "FrontmatterComment", style: t.comment },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !FRONTMATTER_DELIMITER.test(line.text)) return false;
        if (!frontmatterCloses(cx, line.text.length)) return false;
        const children = [cx.elt("FrontmatterMark", 0, 3)];
        let end = line.text.length;
        while (cx.nextLine()) {
          const start = cx.lineStart;
          end = start + line.text.length;
          if (FRONTMATTER_CLOSE.test(line.text)) {
            children.push(cx.elt("FrontmatterMark", start, start + 3));
            cx.nextLine();
            break;
          }
          children.push(...frontmatterLine(cx, start, line.text));
        }
        cx.addElement(cx.elt("Frontmatter", 0, end, children));
        return true;
      },
    },
  ],
};

const DOLLAR = 36;

/** Where the run of `$` that opens display math on `line` ends, or -1 when
 *  the line opens none. As in remark-math, which the document view reads math
 *  with, that is two or more `$` and no other `$` after them on the line, so
 *  a line that is only `$$x$$` is a paragraph. Lezer reads a line indented by
 *  four columns or more as code before it asks this. */
function displayMathOpening(line: Line): number {
  if (line.next !== DOLLAR) return -1;
  let end = line.pos + 1;
  while (end < line.text.length && line.text.charCodeAt(end) === DOLLAR) end++;
  return end - line.pos < 2 || line.text.includes("$", end) ? -1 : end;
}

/** The length of the run of `$` that closes display math opened by `size` of
 *  them on `line`, or -1 when the line does not close it. As in remark-math,
 *  that is a line of at least as many `$` alone, indented by at most three
 *  spaces. */
function displayMathClosing(line: Line, size: number): number {
  if (line.indent - line.baseIndent >= 4) return -1;
  let end = line.pos;
  while (end < line.text.length && line.text.charCodeAt(end) === DOLLAR) end++;
  return end - line.pos >= size && line.skipSpace(end) === line.text.length ? end - line.pos : -1;
}

/** Whether the block a parser reads now is at the top level of the text,
 *  outside any list or quote. */
const atTopLevel = (cx: BlockContext): boolean => cx.parentType().name === "Document";

/**
 * Display math in `$$` fences at the top level, read as the document view
 * reads it. Blank lines inside the fences stay in the math, and math that is
 * not closed takes in the rest of the text, so the Markdown view's blocks end
 * where the document view's do. A file aimed at a Markdown view's caret in
 * the math then goes in beside the whole formula (`paragraphPlace` in
 * base64Collapse.ts), never between its lines. Inside a list or a quote, a
 * line that opens math only ends the paragraph above it, and the lines after
 * it read as Markdown. That list or quote is already the top-level block that
 * holds the math. The math keeps the body colour.
 */
const displayMath: MarkdownConfig = {
  defineNodes: [{ name: "DisplayMath", block: true }, "DisplayMathMark"],
  parseBlock: [
    {
      name: "DisplayMath",
      before: "FencedCode",
      parse(cx, line) {
        const opening = displayMathOpening(line);
        if (opening < 0 || !atTopLevel(cx)) return false;
        const from = cx.lineStart + line.pos;
        const size = opening - line.pos;
        const marks = [cx.elt("DisplayMathMark", from, from + size)];
        while (cx.nextLine()) {
          const closing = displayMathClosing(line, size);
          if (closing >= 0) {
            marks.push(cx.elt("DisplayMathMark", cx.lineStart + line.pos, cx.lineStart + line.pos + closing));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("DisplayMath", from, cx.prevLineEnd(), marks));
        return true;
      },
      // Display math starts a block of its own right below a paragraph's
      // line. A line of a list or quote that is not indented or marked as
      // one then ends that list or quote too, rather than continue its
      // paragraph.
      endLeaf: (_cx, line) => displayMathOpening(line) >= 0,
    },
  ],
};

/** Lezer's Markdown tags, adjusted to the scopes VS Code colours. */
const vscodeScopes: MarkdownConfig = {
  props: [
    styleTags({
      // Only the link text takes the link colour. Brackets and the URL keep the
      // colour around them, as VS Code's punctuation and link scopes do.
      Link: t.link,
      Image: md.image,
      "InlineCode/...": md.inlineCode,
      ListMark: md.listMark,
      QuoteMark: md.quoteMark,
      "TableHeader/...": md.tableHeader,
    }),
  ],
};

/** GitHub-flavoured Markdown, as the document view reads it, with frontmatter,
 *  display math and VS Code's token scopes. `markdown()` alone parses plain
 *  CommonMark, so tables, strikethrough and task lists would read as
 *  paragraphs. */
export function markdownSource(): LanguageSupport {
  return markdown({ base: markdownLanguage, extensions: [frontmatter, displayMath, vscodeScopes] });
}

const color = (name: string): string => `var(--md-src-${name})`;

// Later rules win where a token carries several tags, so containers come first
// and the more specific tokens inside them follow, like VS Code's scopes.
export const sourceHighlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: "bold", color: color("heading") },
  { tag: t.strong, fontWeight: "bold", color: color("strong") },
  { tag: t.emphasis, fontStyle: "italic", color: color("emphasis") },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.string], color: color("string") },
  // Lezer tags HTML entities (&amp;) as a kind of string; VS Code colours them
  // as character constants.
  { tag: t.character, color: color("entity") },
  { tag: t.url, textDecoration: "underline" },
  { tag: md.inlineCode, color: color("code") },
  { tag: md.listMark, color: color("list") },
  { tag: md.quoteMark, color: color("quote") },
  { tag: t.escape, color: color("escape") },
  { tag: t.comment, color: color("comment") },
  { tag: t.tagName, color: color("tag") },
  { tag: t.angleBracket, color: color("tag-punctuation") },
  { tag: t.attributeName, color: color("attribute") },
  { tag: t.attributeValue, color: color("attribute-value") },
  { tag: md.frontmatterKey, color: color("yaml-key") },
  { tag: md.frontmatterValue, color: color("yaml-value") },
]);

/** Selection colours that suit the document theme, from VS Code's editor. */
const selectionTheme = EditorView.theme({
  ".cm-selectionBackground": { background: color("selection-inactive") },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: color("selection"),
  },
  ".cm-selectionMatch": { background: color("selection-match") },
  // A find match keeps its own highlight where it repeats the selected word.
  ".md-find-match .cm-selectionMatch": { background: "transparent" },
});

const matchMark = Decoration.mark({ class: "md-find-match" });
const currentMark = Decoration.mark({ class: "md-find-match md-find-current" });

/** How far past the rendered range to search, so a match that crosses its edge
 *  is still found and painted. CodeMirror's own highlighter uses the same margin. */
const MATCH_MARGIN = 250;

/** Mark every match of the find card's query in the rendered part of the source. */
function paintMatches(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return Decoration.none;
  const { from: selectedFrom, to: selectedTo } = view.state.selection.main;
  const builder = new RangeSetBuilder<Decoration>();
  const cursor = query.getCursor(
    view.state,
    Math.max(0, view.viewport.from - MATCH_MARGIN),
    Math.min(view.state.doc.length, view.viewport.to + MATCH_MARGIN),
  );
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    const { from, to } = match.value;
    if (from === to) continue;
    builder.add(from, to, from === selectedFrom && to === selectedTo ? currentMark : matchMark);
  }
  return builder.finish();
}

/**
 * The find card's highlights, painted like the document view's. CodeMirror's own
 * search highlighter only paints while its search panel is open, and Downpad
 * drives the search state from the find card instead of that panel.
 */
const findHighlights = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = paintMatches(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        getSearchQuery(update.state) !== getSearchQuery(update.startState)
      ) {
        this.decorations = paintMatches(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Syntax colours, selection colours and find highlights for the Markdown view. */
export function markdownSourceStyle(): Extension {
  return [syntaxHighlighting(sourceHighlightStyle), selectionTheme, findHighlights];
}
