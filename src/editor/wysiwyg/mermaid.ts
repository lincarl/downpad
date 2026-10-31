// Crepe copies each preview's HTML, so render SVG without attaching observers or
// handlers to its temporary container. Pele's CSS variables follow the page theme.

let diagramCounter = 0;
let renderer: Promise<typeof import("pele")> | null = null;

type ApplyPreview = (value: null | string | HTMLElement) => void;

/** Load Pele on first use, then draw each fence synchronously in request order. */
async function renderDiagram(content: string, applyPreview: ApplyPreview): Promise<void> {
  try {
    // A shared import keeps successive edits ordered even on the first load.
    // Loading diagram types separately can let an older edit finish last.
    renderer ??= import("pele").catch((error: unknown) => {
      renderer = null;
      throw error;
    });
    const { render } = await renderer;
    const { svg } = render(content, {
      idPrefix: `downpad-diagram-${++diagramCounter}`,
      // Keep diagram links inert, as with Mermaid's strict security setting.
      links: false,
    });
    const element = document.createElement("div");
    element.className = "mermaid-preview";
    element.innerHTML = svg;
    const drawing = element.querySelector("svg");
    if (drawing && !drawing.hasAttribute("aria-label") && !drawing.hasAttribute("aria-labelledby")) {
      drawing.setAttribute("aria-label", "Mermaid diagram");
    }
    applyPreview(element);
  } catch (error) {
    const element = document.createElement("div");
    element.className = "mermaid-error";
    // Parser errors can contain source text. Never interpret them as HTML.
    element.textContent = `Mermaid: ${error instanceof Error ? error.message : String(error)}`;
    applyPreview(element);
  }
}

/** Show a diagram below a Mermaid code block, leaving other languages alone. */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview,
): HTMLElement | null {
  if ((language ?? "").trim().toLowerCase() !== "mermaid" || !content.trim()) return null;
  const loading = document.createElement("div");
  loading.className = "mermaid-preview mermaid-loading";
  loading.textContent = "Rendering diagram…";
  void renderDiagram(content, applyPreview);
  return loading;
}
