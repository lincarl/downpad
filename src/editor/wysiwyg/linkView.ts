// Link rendering for the WYSIWYG view (spec §5.6). Crepe renders links as a
// plain `link` mark. This plugin adds the "text-and-url" presentation, the URL
// shown in a muted suffix after the link text, middle-truncated, with the full
// URL as its title. It also opens a link in the browser on Ctrl/Cmd-click. In
// "text-only" mode no suffix is drawn (traditional rendering); Ctrl-click still
// opens. A click opens the link of the image or the text under the pointer,
// never the next one.
//
// The suffix is a ProseMirror widget Decoration (non-editable, click-through),
// so it never becomes part of the document or the serialized markdown. It is
// drawn outside every mark. ProseMirror otherwise draws a widget inside the
// marks of the text after it, so a link's suffix landed inside a link right
// after it, and a Ctrl/Cmd-click on the suffix opened that other link.
//
// The suffix draws its URL as CSS generated content, with no text in the DOM.
// Chromium has no caret position inside text that can be neither edited nor
// selected, and a click on such text put the caret at the start of the
// paragraph. Chromium puts a click on generated content after the suffix,
// which ProseMirror reads as the link's end.
//
// A plain caret at a link's end, where typed text goes outside the link
// (linkEdges.ts), is drawn after the suffix, where that text shows. A caret
// there on the link's side, where typed text joins the link, and a selection
// that ends there stay before the suffix. Drawing the suffix before a
// selection's end made Chromium type over the selection outside the <a>,
// which ProseMirror read as taking the link off the retyped text.
//
// Double-clicking a link to a local markdown file (a relative/absolute `.md`
// path) opens that file in a tab instead of selecting a word (spec §5.6); the
// open itself is delegated to the app via ctx.openMarkdownFile.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { AddMarkStep, RemoveMarkStep } from "@milkdown/kit/prose/transform";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isElectron } from "../../ipc/env";
import { desktopBridge } from "../../ipc/bridge";
import { resolveMarkdownLinkTarget } from "../../images/pathResolve";
import type { WysiwygContext } from "./context";
import { linkSideCaret } from "./linkEdges";

export const linkUrlKey = new PluginKey<LinkUrlState>("md-easy-link-url");

const MAX_URL = 42;

/** Middle-truncate a long URL: keep the head and tail, elide the middle.
 *  Counts code points, so a cut never splits an emoji's surrogate pair. */
export function middleTruncate(url: string, max: number = MAX_URL): string {
  const chars = Array.from(url);
  if (chars.length <= max) return url;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

function linkMarkHref(node: ProseNode): string | null {
  const mark = node.marks.find((m) => m.type.name === "link");
  return mark ? ((mark.attrs.href as string | undefined) ?? null) : null;
}

/** What the key of each URL suffix starts with, before the link's href. */
const SUFFIX_KEY = "md-link-url:";

/** Add a URL suffix after each run of text in `block` (at `pos`) that links
 *  to one href. A run never crosses a text block, so each block is independent. */
function addBlockSuffixes(block: ProseNode, pos: number, decos: Decoration[]): void {
  let runHref: string | null = null;
  let runEnd = -1;
  const flush = () => {
    if (runHref !== null) {
      // Keyed by the href alone, so an edit that only moves a link keeps its
      // widget instead of drawing it again.
      decos.push(Decoration.widget(runEnd, makeSuffix(runHref), { side: 1, marks: [], ignoreSelection: true, key: `${SUFFIX_KEY}${runHref}`, href: runHref }));
    }
    runHref = null;
  };
  block.forEach((child, offset) => {
    const start = pos + 1 + offset;
    const href = child.isText ? linkMarkHref(child) : null;
    if (href !== null && href === runHref && start === runEnd) {
      runEnd = start + child.nodeSize; // contiguous continuation of the same link
      return;
    }
    flush();
    if (href !== null) {
      runHref = href;
      runEnd = start + child.nodeSize;
    }
  });
  flush();
}

/** URL-suffix decorations for the whole document, one per contiguous link run
 *  (text-and-url only). */
function buildDecorations(doc: ProseNode, linkDisplay: string): DecorationSet {
  if (linkDisplay !== "text-and-url") return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    addBlockSuffixes(node, pos, decos);
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** The text blocks of `tr.doc` that a change in `tr` touched, by position. */
function changedTextblocks(tr: Transaction): Map<number, ProseNode> {
  const blocks = new Map<number, ProseNode>();
  const { doc, mapping } = tr;
  tr.steps.forEach((step, index) => {
    const ranges: Array<[number, number]> = [];
    // Adding or removing a mark, such as a link, moves no positions, so its
    // step map is empty.
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) ranges.push([step.from, step.to]);
    else step.getMap().forEach((_oldFrom, _oldTo, from, to) => ranges.push([from, to]));
    const later = mapping.slice(index + 1);
    for (const [from, to] of ranges) {
      doc.nodesBetween(later.map(from, -1), later.map(to, 1), (node, pos) => {
        if (!node.isTextblock) return true;
        blocks.set(pos, node);
        return false;
      });
    }
  });
  return blocks;
}

/** Bring `old` up to date with `tr`. The set is mapped, and only the text
 *  blocks the change touched get their suffixes again. Rebuilding every suffix
 *  on each keystroke made typing slow in long documents with many links. */
function updateDecorations(tr: Transaction, old: DecorationSet): DecorationSet {
  let set = old.map(tr.mapping, tr.doc);
  for (const [pos, block] of changedTextblocks(tr)) {
    const decos: Decoration[] = [];
    addBlockSuffixes(block, pos, decos);
    set = set.remove(set.find(pos + 1, pos + block.nodeSize - 1)).add(tr.doc, decos);
  }
  return set;
}

interface LinkUrlState {
  /** The linkDisplay setting the decorations were built for. */
  display: string;
  decorations: DecorationSet;
}

/** The suffixes of `state`, with the suffix at a plain caret at a link's end
 *  drawn after the caret, where text typed there goes (see the header). */
function suffixesFor(state: EditorState): DecorationSet | undefined {
  const set = linkUrlKey.getState(state)?.decorations;
  const { selection } = state;
  const caret = selection instanceof TextSelection && selection.empty ? selection.head : null;
  if (!set || caret === null || linkSideCaret(state) === caret) return set;
  const [suffix] = set.find(caret, caret, (spec: { key?: string }) => !!spec.key?.startsWith(SUFFIX_KEY));
  if (!suffix) return set;
  const spec = suffix.spec as { key: string; href: string };
  const after = Decoration.widget(caret, makeSuffix(spec.href), { ...spec, side: -1, key: `${spec.key}:after` });
  return set.remove([suffix]).add(state.doc, [after]);
}

/** The suffix element for `href`. The URL it shows is CSS generated content
 *  from `data-url` (see `.md-link-url::after`), not text in the DOM, so a
 *  click on it puts the caret at the link's end (see the header). */
function makeSuffix(href: string): () => HTMLElement {
  return () => {
    const span = document.createElement("span");
    span.className = "md-link-url";
    span.dataset.url = middleTruncate(href);
    span.title = href;
    return span;
  };
}

function hrefAt(doc: ProseNode, pos: number): string | null {
  const node = doc.nodeAt(pos);
  return node ? linkMarkHref(node) : null;
}

/** The href of the link a click lands on. A click on an inline node such as
 *  an image, or a missing image's chip, lands on that node's own link, or on
 *  none. A click elsewhere lands on the link element the browser found under
 *  the pointer, or on none. For a click on the right half of an image or a
 *  character, ProseMirror gives the position after it, where plain text or
 *  another link can start, so that position cannot name the clicked link. */
function clickedHref(view: EditorView, event: MouseEvent): string | null {
  const inside = view.posAtCoords({ left: event.clientX, top: event.clientY })?.inside ?? -1;
  const clicked = inside >= 0 ? view.state.doc.nodeAt(inside) : null;
  if (clicked?.isInline) return linkMarkHref(clicked);
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  return link && view.dom.contains(link) ? hrefAt(view.state.doc, view.posAtDOM(link, 0)) : null;
}

function openExternally(href: string): void {
  if (isElectron()) {
    void desktopBridge().openExternal(href).catch(() => {});
  } else {
    window.open(href, "_blank", "noopener");
  }
}

/** A `$prose` plugin: text-and-url link suffixes + Ctrl/Cmd-click to open. */
export function linkViewPlugin(ctx: WysiwygContext) {
  return $prose(() => linkUrlPlugin(ctx));
}

/** The ProseMirror plugin behind `linkViewPlugin`. */
export function linkUrlPlugin(ctx: Pick<WysiwygContext, "getSettings" | "getFilePath" | "openMarkdownFile">): Plugin<LinkUrlState> {
  return new Plugin<LinkUrlState>({
    key: linkUrlKey,
    state: {
      init: (_config, state): LinkUrlState => {
        const display = ctx.getSettings().linkDisplay;
        return { display, decorations: buildDecorations(state.doc, display) };
      },
      apply: (tr, old: LinkUrlState): LinkUrlState => {
        if (!tr.docChanged) return old;
        const display = ctx.getSettings().linkDisplay;
        if (display !== old.display || display !== "text-and-url") {
          return { display, decorations: buildDecorations(tr.doc, display) };
        }
        return { display, decorations: updateDecorations(tr, old.decorations) };
      },
    },
    props: {
      decorations: suffixesFor,
      handleClick(view: EditorView, _pos: number, event: MouseEvent): boolean {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const href = clickedHref(view, event);
        if (!href) return false;
        event.preventDefault();
        openExternally(href);
        return true;
      },
      handleDoubleClick(view: EditorView, _pos: number, event: MouseEvent): boolean {
        // Double-click a link to a local .md file → open it in a tab (§5.6),
        // rather than selecting a word. Other links fall through to default.
        if (!ctx.openMarkdownFile) return false;
        const href = clickedHref(view, event);
        if (!href) return false;
        const target = resolveMarkdownLinkTarget(href, ctx.getFilePath());
        if (!target) return false;
        event.preventDefault();
        ctx.openMarkdownFile(target);
        return true;
      },
    },
  });
}
