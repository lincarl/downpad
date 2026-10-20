// Image display, missing-image recovery, and the shared image-node helpers
// (spec §5.5). Three responsibilities:
//
//   1. proxyDomURL — map a markdown `src` to something the WebView can load:
//      data:/http: pass through; a relative/absolute file path is resolved
//      against the document dir and turned into an Electron asset URL so linked
//      images render inline. A local image that cannot be loaded gets an empty
//      data: URL, which fails at once, so the image shows as missing. Answers
//      are kept for the window, so an image asked about before (see
//      lookUpImages and preloadImages.ts) shows its URL from its first render.
//   2. onImageLoadError — when an image fails to load, show it as missing: an
//      image block as a placeholder with the broken icon and its path, an inline
//      image as a chip in its line with the icon and its path. A click on either
//      relocates it via a file dialog (updates the node's src, or looks the
//      file up again when the picked file is at the path it has). missingImages
//      reports the errors of inline images, which Crepe does not, and keeps both
//      in step with the document. They show the node's current path, and go
//      once an image loads there or the path is cleared. A chip inside a text
//      selection is tinted as selected.
//   3. Node helpers (isImageNode / imageAttrs / setImageAttrs / lookups) reused
//      by the image context menu (imageContextMenu.ts).

import { convertFileSrc } from "../../ipc/bridge";
import { openDialog } from "../../ipc/dialogs";
import { $prose } from "@milkdown/kit/utils";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isElectron } from "../../ipc/env";
import { collapseDotSegments, isRemoteOrData, resolveImagePath } from "../../images/pathResolve";
import { resolveImageSrc } from "../../images/imageStore";
import type { WysiwygContext } from "./context";

/** Mutable holder for the live EditorView, populated by the image plugin's view(). */
export interface ViewRef {
  current: EditorView | null;
}

const IMAGE_NODE_NAMES = new Set(["image-block", "image", "image-inline"]);

export function isImageNode(node: ProseNode): boolean {
  return IMAGE_NODE_NAMES.has(node.type.name);
}

/** Read an image node's src, Markdown alt text and title. Every image node keeps
 *  its alt text in `alt` (see imageBlockAlt.ts). A standalone image keeps its title
 *  in `caption`, which Crepe shows under the image. */
export function imageAttrs(node: ProseNode): { src: string; alt: string; title: string } {
  return {
    src: (node.attrs.src as string | undefined) ?? "",
    alt: (node.attrs.alt as string | undefined) ?? "",
    title: (node.attrs.caption as string | undefined) ?? (node.attrs.title as string | null | undefined) ?? "",
  };
}

export function setImageAttrs(
  view: EditorView,
  pos: number,
  node: ProseNode,
  patch: Record<string, unknown>,
): void {
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }));
}

/** Find an image node at/near a document position (atoms sit just before the pos). */
export function imageNodeAtPos(view: EditorView, pos: number): { node: ProseNode; pos: number } | null {
  const { doc } = view.state;
  for (const p of [pos, pos - 1, pos - 2]) {
    if (p < 0) continue;
    const node = doc.nodeAt(p);
    if (node && isImageNode(node)) return { node, pos: p };
  }
  try {
    const clamped = Math.max(0, Math.min(pos, doc.content.size));
    const $p = doc.resolve(clamped);
    for (let d = $p.depth; d >= 0; d--) {
      const node = $p.node(d);
      if (isImageNode(node)) return { node, pos: $p.before(d) };
    }
  } catch {
    // resolve out of range — ignore
  }
  return null;
}

/** Locate the image node corresponding to a DOM element (e.g. a failed <img>). */
export function imageNodeAtDom(view: EditorView, dom: Node): { node: ProseNode; pos: number } | null {
  try {
    return imageNodeAtPos(view, view.posAtDOM(dom, 0));
  } catch {
    return null;
  }
}

/** Open a file dialog filtered to images; returns the chosen path or null. */
export async function pickImageFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** missingImages' state: the position of an image whose view looks its file up
 *  again in this transaction (see showAgain), or null. */
const showAgainKey = new PluginKey<number | null>("md-easy-show-image-again");

/** Look the file of the image at `pos` up again and show it, without a change
 *  to the document, its undo history or its unsaved mark. An image's view looks
 *  its file up when ProseMirror passes it the node again, which ProseMirror does
 *  only when the node or its decorations change. missingImages gives the image
 *  a node decoration for one transaction, and the next takes it off again, so
 *  the image can be shown again the same way later. */
function showAgain(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setMeta(showAgainKey, pos));
  view.dispatch(view.state.tr.setMeta(showAgainKey, null));
}

/** How missing images look their files up: `forget` drops the answer about a
 *  src, and `names` tells whether a picked path is the file a src names. */
interface FileLookup {
  forget: (src: string) => void;
  names: (src: string, path: string) => boolean;
}

/** Point a missing image at a file the user picks. The main process is asked
 *  about that file again, since it may be the one it could not find before.
 *  The file the image already names, such as one put back, leaves the node as
 *  it is, so the image is shown again instead. */
async function relocate(viewRef: ViewRef, dom: Node, files: FileLookup): Promise<void> {
  const view = viewRef.current;
  if (!view) return;
  const found = imageNodeAtDom(view, dom);
  if (!found) return;
  const path = await pickImageFile();
  if (!path) return;
  files.forget(path);
  const { src } = imageAttrs(found.node);
  if (files.names(src, path)) {
    files.forget(src);
    showAgain(view, found.pos);
  } else {
    setImageAttrs(view, found.pos, found.node, { src: path });
  }
}

/** The hover text of a missing inline image, whose chip shows only its path.
 *  An image block's placeholder shows these words as its text. */
const LOCATE_HINT = "Missing image. Click to locate it.";

/** Show an image that failed to load as missing, which a click relocates: an
 *  image block as the missing-image placeholder, an inline image as a chip with
 *  its path. missingImages shows it as an image again. */
function markMissing(event: Event, viewRef: ViewRef, files: FileLookup): void {
  const img = event.target as HTMLElement | null;
  if (!img) return;
  const host = (img.closest?.(".milkdown-image-block, .milkdown-image-inline") as HTMLElement | null) ?? img;
  const view = viewRef.current;
  const info = view ? imageNodeAtDom(view, img) : null;
  const src = info ? imageAttrs(info.node).src : (img.getAttribute?.("src") ?? "");
  host.classList.add("md-image-missing");
  host.dataset.mdPath = src;
  if (host.classList.contains("milkdown-image-inline")) host.title = LOCATE_HINT;
  if (!host.dataset.mdRelocateBound) {
    host.dataset.mdRelocateBound = "1";
    // Crepe draws a new <img> after the path is cleared, so find the node from
    // the element that stays. Only a plain click locates the file. A click with
    // Ctrl or Cmd follows a link around the image, as it does on an image, and
    // one with Shift extends the selection (see missingImages). The second
    // click of a double-click opens no second dialog.
    host.addEventListener("click", (e) => {
      if (!host.classList.contains("md-image-missing")) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.detail > 1) return;
      e.preventDefault();
      e.stopPropagation();
      void relocate(viewRef, host, files);
    });
  }
}

/** Show a missing image as an image again. */
function unmarkMissing(host: HTMLElement): void {
  host.classList.remove("md-image-missing");
  delete host.dataset.mdPath;
  host.removeAttribute("title");
}

/** The class of an inline image inside a text selection, which tints a
 *  missing image's chip as selected. */
const IN_SELECTION = "md-in-selection";

/** Shows missing inline images as missing too, and keeps the images shown as
 *  missing in step with the document. `onError` is the onImageLoadError Crepe
 *  calls for image blocks. Crepe reports no load errors of inline images, so the
 *  plugin passes those to it. An image that loads shows again, also in an <img>
 *  Crepe draws anew. After each change to the document a missing image shows its
 *  node's current path, since another path md-easy cannot load keeps the same
 *  empty URL and gives no new error. One whose path was cleared shows Crepe's
 *  input for a path instead. Load and error events do not bubble, so the plugin
 *  catches them on their way down to the image. Inline images inside a text
 *  selection get the IN_SELECTION class. The plugin also draws the decoration
 *  of showAgain. Shift+click on an image is in shiftClicks.ts. */
export function missingImages(onError: (event: Event) => void) {
  return $prose(
    () =>
      new Plugin({
        view: (editorView) => {
          const onLoad = (event: Event): void => {
            if (!(event.target instanceof HTMLImageElement)) return;
            const host = event.target.closest<HTMLElement>(".md-image-missing");
            if (host) unmarkMissing(host);
          };
          const onInlineError = (event: Event): void => {
            const img = event.target;
            if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("milkdown-image-inline")) onError(event);
          };
          editorView.dom.addEventListener("load", onLoad, true);
          editorView.dom.addEventListener("error", onInlineError, true);
          return {
            update: (view, prevState) => {
              if (view.state.doc === prevState.doc) return;
              for (const host of view.dom.querySelectorAll<HTMLElement>(".md-image-missing")) {
                const found = imageNodeAtDom(view, host);
                if (!found) continue;
                const { src } = imageAttrs(found.node);
                if (src) host.dataset.mdPath = src;
                else unmarkMissing(host);
              }
            },
            destroy: () => {
              editorView.dom.removeEventListener("load", onLoad, true);
              editorView.dom.removeEventListener("error", onInlineError, true);
            },
          };
        },
        key: showAgainKey,
        state: {
          init: () => null,
          apply: (tr) => (tr.getMeta(showAgainKey) as number | null | undefined) ?? null,
        },
        props: {
          decorations: (state) => {
            const marks: Decoration[] = [];
            // The image showAgain shows again gets a decoration without attributes.
            const again = showAgainKey.getState(state);
            const image = again == null ? null : state.doc.nodeAt(again);
            if (again != null && image) marks.push(Decoration.node(again, again + image.nodeSize, {}));
            // Chromium paints no selection over a chip, whose icon and path CSS
            // draws, so mark the inline images a text selection covers.
            const { selection } = state;
            if (!selection.empty && !(selection instanceof NodeSelection)) {
              for (const { $from, $to } of selection.ranges) {
                state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
                  if (node.isInline && isImageNode(node)) {
                    marks.push(Decoration.node(pos, pos + node.nodeSize, { class: IN_SELECTION }));
                  }
                });
              }
            }
            return marks.length ? DecorationSet.create(state.doc, marks) : null;
          },
        },
      }),
  );
}

/** The src shown for a local image md-easy cannot load. It fails at once without a
 *  request or a console message, so the image shows as missing. The raw path would
 *  be looked up next to md-easy's own page, again by every copy of the document
 *  such as the print preview. */
const UNAVAILABLE_IMAGE = "data:,";

/** The longest the first render of a document waits for the main process to
 *  answer about one image, counted from when md-easy first asked about it. */
export const ANSWER_WAIT_MS = 1000;

/** A question to the main process about a local image that has no answer yet. */
interface Lookup {
  answer: Promise<string>;
  /** When a first render stops waiting for it, in `performance.now()` time. */
  waitUntil: number;
}

/** What the main process answered about each local image, by absolute path: its
 *  URL or UNAVAILABLE_IMAGE, or the lookup while it runs. Every editor in the
 *  window shares it, so a document editor built again, for a layout switch, a
 *  settings change or Print, shows its images at once and never asks twice about
 *  a slow path. The main process gives a file one URL for its lifetime. */
const answers = new Map<string, string | Lookup>();

/** Forget every answer, so the main process is asked about each image again.
 *  Called when a document is opened or reloaded, so an image that has appeared
 *  since shows. */
export function forgetImageAnswers(): void {
  answers.clear();
}

/** The answer about a local image, asking the main process if nobody has yet. */
function lookUp(path: string): string | Lookup {
  const known = answers.get(path);
  if (known !== undefined) return known;
  const lookup: Lookup = {
    answer: convertFileSrc(path)
      .catch(() => null)
      .then((url) => {
        const shown = url ?? UNAVAILABLE_IMAGE;
        // Keep it unless it was forgotten meanwhile.
        if (answers.get(path) === lookup) answers.set(path, shown);
        return shown;
      }),
    waitUntil: performance.now() + ANSWER_WAIT_MS,
  };
  answers.set(path, lookup);
  return lookup;
}

/** The absolute path md-easy asks about for an image src in a document saved
 *  at `filePath`, or null when the src is not a local image. Outside Electron
 *  every src is shown as it is. */
function localImagePath(src: string, filePath: string | null): string | null {
  return isElectron() ? resolveImagePath(src, filePath) : null;
}

/**
 * Ask the main process about the local images among `srcs`, in a document
 * saved at `filePath`, before their views exist, so each view shows its
 * image's URL from its first render. Crepe's views render a raw src until an
 * asynchronous answer arrives, and Chromium looks a relative one up next to
 * md-easy's own page, which fails and can show the image as missing for a
 * moment. preloadImages calls this before a document's first render, and a
 * pasted or dropped image waits for it before it goes in.
 *
 * Settles once every answer is in, or each lookup still running was sent
 * ANSWER_WAIT_MS ago. A lookup sent earlier, such as by another editor, is
 * waited for only that long from when it was sent, so a slow path holds back
 * one first render, not every rebuild of the document editor.
 */
export async function lookUpImages(srcs: readonly string[], filePath: string | null): Promise<void> {
  const lookups = new Set<Lookup>();
  for (const src of srcs) {
    const path = localImagePath(src, filePath);
    const known = path ? lookUp(path) : null;
    if (known && typeof known !== "string") lookups.add(known);
  }
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const waitFor = (lookup: Lookup): Promise<unknown> =>
    Promise.race([
      lookup.answer,
      new Promise((resolve) => timers.push(setTimeout(resolve, lookup.waitUntil - performance.now()))),
    ]);
  try {
    await Promise.all([...lookups].map(waitFor));
  } finally {
    timers.forEach(clearTimeout);
  }
}

/** Crepe ImageBlock feature config: render linked images + missing-image UX. */
export function imageBlockFeatureConfig(viewRef: ViewRef, ctx: WysiwygContext) {
  /** The absolute path md-easy asks about for an image src, or null when the src
   *  is not a local image. Outside Electron every src is shown as it is. */
  const localPath = (src: string): string | null => localImagePath(src, ctx.getFilePath());
  /** Forget the answer about an image src, so its next view asks again. */
  const forget = (src: string): void => {
    const path = localPath(src);
    if (path) answers.delete(path);
  };
  /** Whether a picked path is the file an image src names, as a relative src
   *  such as `charts/q3.png` names a file beside the document. */
  const names = (src: string, path: string): boolean => {
    const named = localPath(src);
    return src === path || (named !== null && collapseDotSegments(named) === collapseDotSegments(path));
  };
  /** The local paths the open document shows, kept per document and file path. */
  let shown: { doc: ProseNode; filePath: string | null; paths: Set<string> } | null = null;
  /** Whether an image in the open document still shows `path`. True before the
   *  editor view exists, while every answer is for the first render. */
  const stillShown = (path: string): boolean => {
    const doc = viewRef.current?.state.doc;
    if (!doc) return true;
    const filePath = ctx.getFilePath();
    if (shown?.doc !== doc || shown.filePath !== filePath) {
      const paths = new Set<string>();
      doc.descendants((node) => {
        const src = isImageNode(node) ? localPath(imageAttrs(node).src) : null;
        if (src) paths.add(src);
      });
      shown = { doc, filePath, paths };
    }
    return shown.paths.has(path);
  };
  return {
    // Storage hook for uploaded image *files* (§5.5). Crepe calls this for the
    // `src` of an image chosen in an image block's upload input. Its upload
    // plugin would also call it for an image pasted alone on the clipboard,
    // but md-easy's smart paste takes those first (pasteHandler.ts). Its
    // default returns a `blob:` object URL, which is session-scoped and would
    // land in the saved markdown (dead on reload). Route through our store so
    // the src is a base64 data URI (embed) or an attachments path instead, the
    // form we persist. An image stored as a file is asked about before it goes
    // in (`lookUpImages`), so its view shows the image from its first render.
    onUpload: async (file: File): Promise<string> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const src = await resolveImageSrc(bytes, file.type || "image/png", ctx, (stored, filePath) => lookUpImages([stored], filePath));
      // null = user cancelled the prompt-to-save for an attachment; leave the
      // src empty so nothing dangling (a blob URL) is written. The upload
      // input then leaves the image block empty.
      return src ?? "";
    },
    /** Map a Markdown image src to a URL the page can load, for block and inline
     *  images. URLs such as http:, data: and file: pass through, as does every src
     *  outside Electron. An empty src stays empty so Crepe shows its upload input.
     *  A local path the main process does not authorize (missing, not an image, or
     *  otherwise refused), or one relative to a document that is not saved yet,
     *  becomes UNAVAILABLE_IMAGE.
     *
     *  Once the main process has answered for a local image, later calls return
     *  that answer at once. Crepe's image views render the raw src until an
     *  asynchronous answer arrives, and Chromium requests a relative one next to
     *  md-easy's own page. preloadImages asks about a document's images before
     *  its first render for this reason, and a pasted or dropped image is asked
     *  about before it goes in (`lookUpImages`). Answers last until a document
     *  is opened or reloaded, so a missing image that appears meanwhile shows
     *  then.
     *
     *  Crepe shows an asynchronous answer whenever it arrives, even if the view's
     *  src has changed since. An answer for a path no image in the document shows
     *  any more never settles, so it cannot replace a newer one. */
    proxyDomURL: (url: string): string | Promise<string> => {
      if (!url || !isElectron() || isRemoteOrData(url)) return url;
      const path = localPath(url);
      if (!path) return UNAVAILABLE_IMAGE;
      const known = lookUp(path);
      if (typeof known === "string") return known;
      return known.answer.then((shownUrl) => (stillShown(path) ? shownUrl : new Promise<string>(() => {})));
    },
    /** Ask about the document's images before their views exist
     *  (preloadImages), as `lookUpImages` does. */
    preload: (srcs: readonly string[]): Promise<void> => lookUpImages(srcs, ctx.getFilePath()),
    onImageLoadError: (event: Event): void => markMissing(event, viewRef, { forget, names }),
  };
}
