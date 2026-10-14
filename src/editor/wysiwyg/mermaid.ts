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

type ApplyPreview = (value: null | string | HTMLElement) => void;

/** A diagram on the page: its source, Crepe's callback that swaps its preview,
 *  the element now shown, and the document theme it was drawn in. */
interface LivePreview {
  code: string;
  apply: ApplyPreview;
  element: HTMLElement;
  theme: "dark" | "default";
  settled: boolean;
}

const livePreviews = new Set<LivePreview>();
let themeObserver: MutationObserver | null = null;

/** Redraw the diagrams still on the page when the document theme changes, since
 *  Mermaid bakes its theme into the SVG. Diagrams that left the page are dropped. */
function watchDocumentTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => {
    const theme = currentTheme();
    for (const preview of [...livePreviews]) {
      if (!preview.element.isConnected) {
        if (preview.settled) livePreviews.delete(preview);
        continue;
      }
      if (preview.theme !== theme) void renderInto(preview);
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-editor-theme"],
  });
}

function show(preview: LivePreview, element: HTMLElement): void {
  preview.element = element;
  preview.settled = true;
  preview.apply(element);
}

async function renderInto(preview: LivePreview): Promise<void> {
  const theme = currentTheme();
  preview.theme = theme;
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
    // parse (suppressErrors) validates without leaving an error node in the DOM.
    const parsed = await mermaid.parse(preview.code, { suppressErrors: true });
    if (!parsed) {
      show(preview, errorElement("invalid diagram syntax"));
      return;
    }
    diagramCounter += 1;
    const { svg } = await mermaid.render(`md-easy-mermaid-${diagramCounter}`, preview.code);
    const el = document.createElement("div");
    el.className = "mermaid-preview";
    el.innerHTML = svg;
    show(preview, el);
  } catch (err) {
    show(preview, errorElement(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Crepe code-block `renderPreview` hook. Returns null for non-mermaid languages
 * (normal code block, no preview); for mermaid, shows a loading placeholder and
 * renders asynchronously, swapping in the SVG (or an error block) when ready.
 * The diagram is drawn again whenever the document theme changes.
 */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview,
): HTMLElement | null {
  if ((language ?? "").trim().toLowerCase() !== "mermaid") return null;
  const code = content.trim();
  if (!code) return null;
  // Drop diagrams that finished and have since left the page (edited or closed).
  for (const preview of livePreviews) {
    if (preview.settled && !preview.element.isConnected) livePreviews.delete(preview);
  }
  const loading = loadingElement();
  const preview: LivePreview = { code, apply: applyPreview, element: loading, theme: currentTheme(), settled: false };
  livePreviews.add(preview);
  watchDocumentTheme();
  void renderInto(preview);
  return loading;
}
