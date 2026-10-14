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
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isElectron } from "../../ipc/env";
import { desktopBridge } from "../../ipc/bridge";
import { resolveMarkdownLinkTarget } from "../../images/pathResolve";
import type { WysiwygContext } from "./context";

export const linkUrlKey = new PluginKey("md-easy-link-url");

const MAX_URL = 42;

/** Middle-truncate a long URL: keep the head and tail, elide the middle. */
export function middleTruncate(url: string, max: number = MAX_URL): string {
  if (url.length <= max) return url;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${url.slice(0, head)}…${url.slice(url.length - tail)}`;
}

function linkMarkHref(node: ProseNode): string | null {
  const mark = node.marks.find((m) => m.type.name === "link");
  return mark ? ((mark.attrs.href as string | undefined) ?? null) : null;
}

/** Build URL-suffix decorations, one per contiguous link run (text-and-url only). */
function buildDecorations(doc: ProseNode, linkDisplay: string): DecorationSet {
  if (linkDisplay !== "text-and-url") return DecorationSet.empty;

  const decos: Decoration[] = [];
  let runHref: string | null = null;
  let runEnd = -1;

  const flush = () => {
    if (runHref !== null && runEnd >= 0) {
      decos.push(
        Decoration.widget(runEnd, makeSuffix(runHref), {
          side: 1,
          ignoreSelection: true,
          key: `md-link-url:${runEnd}:${runHref}`,
        }),
      );
    }
    runHref = null;
    runEnd = -1;
  };

  doc.descendants((node, pos) => {
    if (!node.isText) {
      // A non-text node breaks any open link run.
      if (node.isBlock) flush();
      return;
    }
    const href = linkMarkHref(node);
    const start = pos;
    const end = pos + node.nodeSize;
    if (href === null) {
      flush();
      return;
    }
    if (runHref === href && start === runEnd) {
      runEnd = end; // contiguous continuation of the same link
    } else {
      flush();
      runHref = href;
      runEnd = end;
    }
  });
  flush();

  return DecorationSet.create(doc, decos);
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
  return $prose(
    () =>
      new Plugin({
        key: linkUrlKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc, ctx.getSettings().linkDisplay),
          apply: (tr, old) =>
            tr.docChanged ? buildDecorations(tr.doc, ctx.getSettings().linkDisplay) : old,
        },
        props: {
          decorations(state) {
            return linkUrlKey.getState(state) as DecorationSet | undefined;
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
      }),
  );
}
