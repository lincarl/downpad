// Prepares what the print workspace prints (spec §5.21).
//
// Fidelity: when a WYSIWYG editor is already mounted we take its live,
// already-rendered ProseMirror node (mermaid diagrams included). Otherwise (the
// Markdown-only layout, or the Recent view) the canonical markdown is rendered
// through a transient, off-screen WYSIWYG editor and cloned from there — so the
// "Document" version always shows the rendered document, never raw markdown,
// regardless of which view is on screen.
//
// The result is a detached, sanitized clone: the transient editor is torn down
// immediately, and the workspace re-clones this node every time the user changes
// a page option.

import { WysiwygEditor } from "../editor/wysiwyg/WysiwygEditor";
import { serializerStyleFromSettings, type Settings } from "../state/types";
import type { WysiwygContext } from "../editor/wysiwyg/context";
import { sanitize } from "./printRender";
import type { PrintJob } from "./PrintWorkspace";

export interface PrintRequest {
  /** Canonical markdown of the active document (printed as-is for the Markdown
   *  version, and used for the offscreen render of the Document version). */
  markdown: string;
  /** A live, already-rendered ProseMirror node, or null when no WYSIWYG editor
   *  is mounted (Markdown-only layout / Recent view). */
  liveNode: Element | null;
  settings: Settings;
  context: WysiwygContext;
  /** File name for the header bar and the running header ("Untitled" when unsaved). */
  docTitle: string;
}

/** Mermaid renders asynchronously (lazy import); give it a beat to paint its SVG
 *  before the offscreen render is snapshotted. */
const MERMAID_SETTLE_MS = 350;

/** Build the print job, or null when there is nothing to print. */
export async function preparePrintJob(req: PrintRequest): Promise<PrintJob | null> {
  if (!req.liveNode && !req.markdown.trim()) return null;
  const documentNode = await renderDocumentNode(req);
  return { markdown: req.markdown, documentNode, docTitle: req.docTitle };
}

async function renderDocumentNode(req: PrintRequest): Promise<Element | null> {
  if (req.liveNode) return sanitize(req.liveNode.cloneNode(true) as Element);

  const host = document.createElement("div");
  host.className = "print-offscreen";
  document.body.appendChild(host);
  const editor = new WysiwygEditor();
  try {
    await editor.mount(
      host,
      req.markdown,
      { onChange: () => {} },
      serializerStyleFromSettings(req.settings),
      req.context,
    );
    await sleep(MERMAID_SETTLE_MS);
    const node = host.querySelector(".ProseMirror");
    return node ? sanitize(node.cloneNode(true) as Element) : null;
  } catch (err) {
    console.error("md-easy: offscreen print render failed", err);
    return null;
  } finally {
    await editor.destroy().catch(() => {});
    host.remove();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
