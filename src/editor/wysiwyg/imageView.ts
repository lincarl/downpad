// Image display, missing-image recovery, and the shared image-node helpers
// (spec §5.5). Three responsibilities:
//
//   1. proxyDomURL — map a markdown `src` to something the WebView can load:
//      data:/http: pass through; a relative/absolute file path is resolved
//      against the document dir and turned into an Electron asset URL so linked
//      images render inline. A local image that cannot be loaded gets an empty
//      data: URL, which fails to load and so shows the placeholder.
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
 *  request or a console message and shows the missing-image placeholder. The raw
 *  path would be looked up next to md-easy's own page, again by every copy of the
 *  document such as the print preview. */
const UNAVAILABLE_IMAGE = "data:,";

/** Crepe ImageBlock feature config: render linked images + missing-image UX. */
export function imageBlockFeatureConfig(viewRef: ViewRef, ctx: WysiwygContext) {
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
    proxyDomURL: async (url: string): Promise<string> => {
      // An empty src shows Crepe's upload input, so it passes through as is.
      if (!url || !isElectron() || isRemoteOrData(url)) return url;
      const abs = resolveImagePath(url, ctx.getFilePath());
      // A path that is not an image or cannot be read shows as missing too.
      const authorized = abs ? await convertFileSrc(abs).catch(() => null) : null;
      return authorized ?? UNAVAILABLE_IMAGE;
    },
    onImageLoadError: (event: Event): void => markMissing(event, viewRef),
  };
}
