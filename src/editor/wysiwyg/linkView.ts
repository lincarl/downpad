// Link rendering for the WYSIWYG view (spec §5.6). Crepe renders links as a
// plain `link` mark; this plugin adds the "text-and-url" presentation — the URL
// shown in a muted suffix after the link text, middle-truncated, full URL on
// hover — and Ctrl/Cmd-click to open in the browser. In "text-only" mode no
// suffix is drawn (traditional rendering); Ctrl-click still opens.
//
// The suffix is a ProseMirror widget Decoration (non-editable, click-through),
// so it never becomes part of the document or the serialized markdown.
//
// Double-clicking a link to a local markdown file (a relative/absolute `.md`
// path) opens that file in a tab instead of selecting a word (spec §5.6); the
// open itself is delegated to the app via ctx.openMarkdownFile.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
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

/** Add a URL suffix after each run of text in `block` (at `pos`) that links
 *  to one href. A run never crosses a text block, so each block is independent. */
function addBlockSuffixes(block: ProseNode, pos: number, decos: Decoration[]): void {
  let runHref: string | null = null;
  let runEnd = -1;
  const flush = () => {
    if (runHref !== null) {
      // Keyed by the href alone, so an edit that only moves a link keeps its
      // widget instead of drawing it again.
      decos.push(Decoration.widget(runEnd, makeSuffix(runHref), { side: 1, ignoreSelection: true, key: `md-link-url:${runHref}` }));
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

function makeSuffix(href: string): () => HTMLElement {
  return () => {
    const span = document.createElement("span");
    span.className = "md-link-url";
    span.textContent = ` (${middleTruncate(href)})`;
    span.title = href;
    return span;
  };
}

function hrefAt(doc: ProseNode, pos: number): string | null {
  const node = doc.nodeAt(pos);
  return node ? linkMarkHref(node) : null;
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
      decorations(state) {
        return linkUrlKey.getState(state)?.decorations;
      },
      handleClick(view: EditorView, pos: number, event: MouseEvent): boolean {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const href = hrefAt(view.state.doc, pos);
        if (!href) return false;
        event.preventDefault();
        openExternally(href);
        return true;
      },
      handleDoubleClick(view: EditorView, pos: number, event: MouseEvent): boolean {
        // Double-click a link to a local .md file → open it in a tab (§5.6),
        // rather than selecting a word. Other links fall through to default.
        if (!ctx.openMarkdownFile) return false;
        const href = hrefAt(view.state.doc, pos);
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
