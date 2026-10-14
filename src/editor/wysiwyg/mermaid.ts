// Mermaid rendering for the WYSIWYG view (spec §5.2). Crepe ships no Mermaid
// node; instead the code-block (CodeMirror) feature exposes a `renderPreview`
// hook that renders a preview below the editable source — the maintainer-endorsed
// path (design.md §1.1). We only act on ```mermaid blocks and leave every other
// language untouched (return null = no preview pane).
//
// `mermaid` is heavy, so it's lazy-imported on first use to protect cold-start.

type MermaidModule = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidModule> | null = null;
let diagramCounter = 0;

async function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

/** Diagrams sit on the document page, so they follow the document theme, which
 *  can differ from the UI theme. */
function currentTheme(): "dark" | "default" {
  return document.documentElement.dataset.editorTheme === "dark" ? "dark" : "default";
}

function loadingElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "mermaid-preview mermaid-loading";
  el.textContent = "Rendering diagram…";
  return el;
}

function errorElement(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "mermaid-error";
  el.textContent = `Mermaid: ${message}`;
  return el;
}

async function renderInto(code: string, applyPreview: ApplyPreview): Promise<void> {
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, theme: currentTheme(), securityLevel: "strict" });
    // parse (suppressErrors) validates without leaving an error node in the DOM.
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    if (!parsed) {
      applyPreview(errorElement("invalid diagram syntax"));
      return;
    }
    diagramCounter += 1;
    const { svg } = await mermaid.render(`md-easy-mermaid-${diagramCounter}`, code);
    const el = document.createElement("div");
    el.className = "mermaid-preview";
    el.innerHTML = svg;
    applyPreview(el);
  } catch (err) {
    applyPreview(errorElement(err instanceof Error ? err.message : String(err)));
  }
}

type ApplyPreview = (value: null | string | HTMLElement) => void;

/**
 * Crepe code-block `renderPreview` hook. Returns null for non-mermaid languages
 * (normal code block, no preview); for mermaid, shows a loading placeholder and
 * renders asynchronously, swapping in the SVG (or an error block) when ready.
 */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview,
): HTMLElement | null {
  if ((language ?? "").trim().toLowerCase() !== "mermaid") return null;
  const code = content.trim();
  if (!code) return null;
  void renderInto(code, applyPreview);
  return loadingElement();
}
