// Image display, missing-image recovery, and the shared image-node helpers
// (spec §5.5). Three responsibilities:
//
//   1. proxyDomURL — map a markdown `src` to something the WebView can load:
//      data:/http: pass through; a relative/absolute file path is resolved
//      against the document dir and turned into an Electron asset URL so linked
//      images render inline. A local image that cannot be loaded gets an empty
//      data: URL, which fails at once, so an image block shows the missing-image
//      placeholder and an inline image its broken-image icon. Answers are kept
//      for the window, so an image asked about before (see preloadImages.ts)
//      shows its URL from its first render.
//   2. onImageLoadError — when an image fails to load, mark its block as a
//      missing-image placeholder (broken icon + path) and make it click-to-
//      relocate via a file dialog (updates the node's src).
//   3. Node helpers (isImageNode / imageAttrs / setImageAttrs / lookups) reused
//      by the image context menu (imageContextMenu.ts).

import { convertFileSrc } from "../../ipc/bridge";
import { openDialog } from "../../ipc/dialogs";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isElectron } from "../../ipc/env";
import { isRemoteOrData, resolveImagePath } from "../../images/pathResolve";
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

async function relocate(viewRef: ViewRef, dom: Node): Promise<void> {
  const view = viewRef.current;
  if (!view) return;
  const found = imageNodeAtDom(view, dom);
  if (!found) return;
  const path = await pickImageFile();
  if (path) setImageAttrs(view, found.pos, found.node, { src: path });
}

function markMissing(event: Event, viewRef: ViewRef): void {
  const img = event.target as HTMLElement | null;
  if (!img) return;
  const host = (img.closest?.(".milkdown-image-block") as HTMLElement | null) ?? img;
  const view = viewRef.current;
  const info = view ? imageNodeAtDom(view, img) : null;
  const src = info ? imageAttrs(info.node).src : (img.getAttribute?.("src") ?? "");
  host.classList.add("md-image-missing");
  host.dataset.mdPath = src;
  host.title = `Missing image: ${src} — click to relocate`;
  if (!host.dataset.mdRelocateBound) {
    host.dataset.mdRelocateBound = "1";
    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void relocate(viewRef, img);
    });
  }
}

/** The src shown for a local image md-easy cannot load. It fails at once without a
 *  request or a console message, so an image block shows the missing-image
 *  placeholder and an inline image its broken-image icon. The raw path would be
 *  looked up next to md-easy's own page, again by every copy of the document such
 *  as the print preview. */
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

/** Crepe ImageBlock feature config: render linked images + missing-image UX. */
export function imageBlockFeatureConfig(viewRef: ViewRef, ctx: WysiwygContext) {
  /** The absolute path md-easy asks about for an image src, or null when the src
   *  is not a local image. Outside Electron every src is shown as it is. */
  const localPath = (src: string): string | null =>
    isElectron() ? resolveImagePath(src, ctx.getFilePath()) : null;
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
    // Storage hook for pasted/dropped/uploaded image *files* (§5.5). Crepe's
    // upload pipeline calls this for the image's `src`; its default returns a
    // `blob:` object URL, which is session-scoped and would land in the saved
    // markdown (dead on reload). Route through our store so the src is a base64
    // data URI (embed) or an attachments path instead — the form we persist.
    onUpload: async (file: File): Promise<string> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const src = await resolveImageSrc(bytes, file.type || "image/png", ctx);
      // null = user cancelled the prompt-to-save for an attachment; leave the
      // src empty so nothing dangling (a blob URL) is written.
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
     *  its first render for this reason. Answers last until a document is opened
     *  or reloaded, so a missing image that appears meanwhile shows then.
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
    /** Ask about images before their views exist (preloadImages). Settles once
     *  every answer is in, or each lookup still running was sent ANSWER_WAIT_MS
     *  ago. A lookup another editor sent earlier is waited for only that long
     *  from when it was sent, so a slow path holds back one first render, not
     *  every rebuild of the document editor. */
    preload: async (srcs: readonly string[]): Promise<void> => {
      const lookups = new Set<Lookup>();
      for (const src of srcs) {
        const path = localPath(src);
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
    },
    onImageLoadError: (event: Event): void => markMissing(event, viewRef),
  };
}
