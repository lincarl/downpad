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
import { EditorView as CodeMirrorView, lineNumbers } from "@codemirror/view";
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
  if (req.liveNode) return cloneCompleteDocument(req.liveNode);

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
    return node ? cloneCompleteDocument(node) : null;
  } catch (err) {
    console.error("md-easy: offscreen print render failed", err);
    return null;
  } finally {
    await editor.destroy().catch(() => {});
    host.remove();
  }
}

/** Print every code line, including folded lines and Crepe's offscreen blocks. */
function cloneCompleteDocument(source: Element): Element {
  const clone = source.cloneNode(true) as Element;
  const liveEditors = source.querySelectorAll<HTMLElement>(".cm-editor");
  const clonedEditors = clone.querySelectorAll<HTMLElement>(".cm-editor");
  liveEditors.forEach((live, index) => {
    const view = CodeMirrorView.findFromDOM(live);
    const copy = clonedEditors[index];
    const content = copy?.querySelector<HTMLElement>(".cm-content");
    if (!view || !content) return;

    const rendered = new Map<number, HTMLElement>();
    for (const line of live.querySelectorAll<HTMLElement>(".cm-content > .cm-line")) {
      const position = view.posAtDOM(line, 0);
      rendered.set(view.state.doc.lineAt(position).number, line);
    }
    const lines = document.createDocumentFragment();
    for (let offset = 0; offset < view.state.doc.lines; offset++) {
      const number = offset + 1;
      const text = view.state.doc.line(number).text;
      const visible = rendered.get(number);
      // Preserve highlighting when the live line contains the complete source.
      if (visible?.textContent === text) {
        lines.appendChild(visible.cloneNode(true));
      } else {
        const line = document.createElement("div");
        line.className = "cm-line";
        if (text) line.textContent = text;
        else line.appendChild(document.createElement("br"));
        lines.appendChild(line);
      }
    }
    content.replaceChildren(lines);

    const column = copy?.querySelector<HTMLElement>(".cm-lineNumbers");
    const template = live.querySelector<HTMLElement>(".cm-lineNumbers .cm-gutterElement");
    if (!column || !template) return;
    const cells = document.createDocumentFragment();
    for (let offset = 0; offset < view.state.doc.lines; offset++) {
      const cell = template.cloneNode(false) as HTMLElement;
      cell.style.visibility = "";
      cell.style.height = "";
      cell.style.marginTop = "";
      cell.textContent = String(offset + 1);
      cells.appendChild(cell);
    }
    column.replaceChildren(cells);
    const gutters = copy?.querySelector<HTMLElement>(".cm-gutters");
    if (gutters) gutters.style.minHeight = "";
  });
  // Crepe replaces whole offscreen editors with plain-text placeholders. Give
  // those blocks the same complete lines and numbers as mounted editors. The
  // temporary editor stays detached, and only its static clone reaches print.
  for (const placeholder of clone.querySelectorAll(".milkdown-code-block-placeholder")) {
    const host = document.createElement("div");
    host.className = "codemirror-host";
    const view = new CodeMirrorView({
      parent: host,
      doc: placeholder.textContent ?? "",
      extensions: [lineNumbers()],
    });
    try {
      placeholder.replaceWith(cloneCompleteDocument(host));
    } finally {
      view.destroy();
    }
  }
  return sanitize(clone);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
