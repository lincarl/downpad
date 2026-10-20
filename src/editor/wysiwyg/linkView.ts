// Link rendering for the WYSIWYG view (spec §5.6). Crepe renders links as a
// plain `link` mark. This plugin adds the "text-and-url" presentation, the URL
// shown in a muted suffix after the link text, middle-truncated, with the full
// URL as its title. It also opens a link in the browser on Ctrl/Cmd-click. In
// "text-only" mode no suffix is drawn (traditional rendering); Ctrl-click still
// opens. A click opens the link of the image, the text or the suffix under the
// pointer, never the next one.
//
// A Ctrl/Cmd-click that opens no link acts as a plain click. ProseMirror
// selects the block under the pointer as a node on a click with that modifier
// (Cmd on macOS, Ctrl elsewhere), and the block around it on the next one, so
// the next key replaced a whole paragraph, heading or list.
//
// Shift+click on link text extends the selection, as on other text. Chromium
// does not extend the selection when the mouse goes down on a link, even in
// an editable element, and ProseMirror leaves Shift+click to the browser, so
// the click put a caret there instead.
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
// which ProseMirror reads as the link's end. Print writes the URL into the
// suffix as text (printRender.ts), because the paginator breaks a paragraph
// or heading only between lines of its text.
//
// The suffix holds an empty comment, so it has a child but no text. Chromium
// treats a non-editable element with no children as one solid object, and
// an input method's composition right after such a suffix broke once it had
// more than one step. Chromium dropped the composition and put the committed
// text in a second time. Text in the suffix, even a zero-width space, also
// kept the composition, but Chromium then lost the caret when a composition
// there was emptied, and the next one went in at the paragraph's start.
//
// A caret at a link's end is drawn after the suffix when text typed there
// goes outside the link, such as at a plain caret (linkEdges.ts) or into a
// link right after it, because that text shows after the suffix. A caret
// there that types into the link, as on the link's side, and a selection
// that ends there stay before the suffix. Drawing the suffix before a
// selection's end made Chromium type over the selection outside the <a>,
// which ProseMirror read as taking the link off the retyped text.
//
// Double-clicking a link to a local markdown file (a relative/absolute `.md`
// path) opens that file in a tab instead of selecting a word (spec §5.6); the
// open itself is delegated to the app via ctx.openMarkdownFile.

import { $prose } from "@milkdown/kit/utils";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { AddMarkStep, RemoveMarkStep } from "@milkdown/kit/prose/transform";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isElectron } from "../../ipc/env";
import { desktopBridge } from "../../ipc/bridge";
import { resolveMarkdownLinkTarget } from "../../images/pathResolve";
import type { WysiwygContext } from "./context";

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

/** The suffixes of `state`. The suffix at a caret is drawn before the caret,
 *  unless text typed there joins the suffix's link (see the header). */
function suffixesFor(state: EditorState): DecorationSet | undefined {
  const set = linkUrlKey.getState(state)?.decorations;
  const { selection } = state;
  const $caret = selection instanceof TextSelection ? selection.$cursor : null;
  if (!set || !$caret) return set;
  const [suffix] = set.find($caret.pos, $caret.pos, (spec: { key?: string }) => !!spec.key?.startsWith(SUFFIX_KEY));
  if (!suffix) return set;
  const spec = suffix.spec as { key: string; href: string };
  const typed = state.storedMarks ?? $caret.marks();
  if (typed.some((mark) => mark.type.name === "link" && mark.attrs.href === spec.href)) return set;
  const after = Decoration.widget($caret.pos, makeSuffix(spec.href), { ...spec, side: -1, key: `${spec.key}:after` });
  return set.remove([suffix]).add(state.doc, [after]);
}

/** The suffix element for `href`. The URL it shows is CSS generated content
 *  from `data-url` (see `.md-link-url[data-url]::after`), not text in the
 *  DOM, so a click on it puts the caret at the link's end. The empty comment
 *  keeps an input method's composition after it working (see the header). */
function makeSuffix(href: string): () => HTMLElement {
  return () => {
    const span = document.createElement("span");
    span.className = "md-link-url";
    span.dataset.url = middleTruncate(href);
    span.title = href;
    span.append(document.createComment(""));
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

/** The href of the link whose URL suffix is under the pointer, or null. The
 *  suffix takes no pointer events, so a click on it targets the block around
 *  it, and the pointer is matched against the suffixes in that block. */
function suffixHref(view: EditorView, event: MouseEvent): string | null {
  const block = event.target instanceof Element && view.dom.contains(event.target) ? event.target : null;
  for (const suffix of block?.querySelectorAll<HTMLElement>(".md-link-url") ?? []) {
    const box = suffix.getBoundingClientRect();
    const over = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    // The suffix sits right after the last character of its link.
    if (over) return hrefAt(view.state.doc, view.posAtDOM(suffix, 0) - 1);
  }
  return null;
}

/** Handle a Ctrl/Cmd-click that opens no link as ProseMirror handles a plain
 *  click, at `pos`. That leaves the caret where the browser put it, selects
 *  an image or other leaf node under the pointer, and, as ProseMirror does
 *  for Chromium, moves a hidden node selection near the pointer, since
 *  Chromium can report no change for a click at its hidden caret. */
function clickAsPlain(view: EditorView, pos: number, event: MouseEvent): true {
  const { doc, selection } = view.state;
  const inside = view.posAtCoords({ left: event.clientX, top: event.clientY })?.inside ?? -1;
  const leaf = inside >= 0 ? doc.nodeAt(inside) : null;
  let next: Selection | null = null;
  if (leaf?.isAtom && NodeSelection.isSelectable(leaf)) next = NodeSelection.create(doc, inside);
  else if (!selection.visible && Math.min(Math.abs(pos - selection.from), Math.abs(pos - selection.to)) <= 2) next = Selection.near(doc.resolve(pos));
  if (!next) return true;
  if (!view.hasFocus()) view.focus();
  if (!next.eq(selection)) view.dispatch(view.state.tr.setSelection(next).setMeta("pointer", true));
  return true;
}

/** Extend the selection to a Shift+click on link text, and on to the
 *  pointer while the button stays down, as Chromium does for a Shift+click
 *  or Shift+drag on other text. Chromium put a caret at the click instead
 *  (see the header). A press on an image inside a link is left alone, and
 *  so is a drag another handler takes over, such as prosemirror-tables'
 *  selection of the cells the pointer crosses. prosemirror-tables runs
 *  first and takes a Shift+click into another cell itself. Unlike
 *  Chromium's drag selection, the drag does not scroll the document when
 *  the pointer leaves it. */
function shiftClickOnLink(view: EditorView, event: MouseEvent): boolean {
  if (!event.shiftKey || event.button !== 0 || !(event.target instanceof Element)) return false;
  const link = event.target.closest("a");
  const found = link && view.dom.contains(link) ? view.posAtCoords({ left: event.clientX, top: event.clientY }) : null;
  if (!found || (found.inside >= 0 && view.state.doc.nodeAt(found.inside)?.isInline)) return false;
  event.preventDefault();
  view.focus();
  const { anchor } = view.state.selection;
  const extend = (head: number): void => {
    const { doc, selection } = view.state;
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (!next.eq(selection)) view.dispatch(view.state.tr.setSelection(next).setMeta("pointer", true));
  };
  extend(found.pos);
  const root = view.dom.ownerDocument;
  const move = (moved: MouseEvent): void => {
    if (view.isDestroyed || !(moved.buttons & 1) || !(view.state.selection instanceof TextSelection)) return end();
    const at = view.posAtCoords({ left: moved.clientX, top: moved.clientY });
    if (at) extend(at.pos);
  };
  const end = (): void => {
    root.removeEventListener("mousemove", move);
    root.removeEventListener("mouseup", end);
  };
  root.addEventListener("mousemove", move);
  root.addEventListener("mouseup", end);
  return true;
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
      handleClick(view: EditorView, pos: number, event: MouseEvent): boolean {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const href = clickedHref(view, event) ?? suffixHref(view, event);
        if (!href) return clickAsPlain(view, pos, event);
        event.preventDefault();
        openExternally(href);
        return true;
      },
      handleDOMEvents: {
        mousedown: shiftClickOnLink,
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
