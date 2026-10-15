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

/** A diagram in an editor: its number, source, Crepe's callback that swaps its
 *  preview, the document theme of its latest render, whether a render has been
 *  shown, and the latest render's number (an older render's result is dropped). */
interface LivePreview {
  id: number;
  code: string;
  apply: ApplyPreview;
  theme: "dark" | "default";
  settled: boolean;
  generation: number;
}

const livePreviews = new Set<LivePreview>();
let previewCounter = 0;
let themeObserver: MutationObserver | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** Crepe shows a sanitized copy of each preview element, not the element itself,
 *  so a diagram is found on the page by the number its copies carry. Hidden
 *  panes of other tabs stay in the page and count. */
function onPage(preview: LivePreview): boolean {
  return document.querySelector(`[data-mermaid-preview="${preview.id}"]`) !== null;
}

/** Forget diagrams whose preview has left the page (edited, replaced or closed).
 *  Runs on a later task, once Crepe has shown the previews of the current one. */
function schedulePrune(): void {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    for (const preview of livePreviews) {
      if (preview.settled && !onPage(preview)) livePreviews.delete(preview);
    }
  }, 0);
}

/** Redraw the diagrams still on the page when the document theme changes, since
 *  Mermaid bakes its theme into the SVG. Diagrams that left the page are dropped. */
function watchDocumentTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => {
    const theme = currentTheme();
    for (const preview of [...livePreviews]) {
      if (preview.settled && !onPage(preview)) livePreviews.delete(preview);
      else if (preview.theme !== theme) void renderInto(preview);
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-editor-theme"],
  });
}

function show(preview: LivePreview, element: HTMLElement): void {
  element.dataset.mermaidPreview = String(preview.id);
  preview.settled = true;
  preview.apply(element);
}

let renderQueue: Promise<unknown> = Promise.resolve();

/** Run renders one at a time. Mermaid's theme is global configuration and it
 *  queues parse and render separately, so an overlapping render could set its
 *  theme between another render's parse and draw. */
function inRenderQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task);
  renderQueue = run.catch(() => {});
  return run;
}

async function renderInto(preview: LivePreview): Promise<void> {
  const theme = currentTheme();
  preview.theme = theme;
  const generation = ++preview.generation;
  // A theme change starts a newer render of the same diagram, which wins.
  const superseded = (): boolean => preview.generation !== generation;
  try {
    const element = await inRenderQueue(async () => {
      if (superseded()) return null;
      const mermaid = await loadMermaid();
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
      // parse (suppressErrors) validates without leaving an error node in the DOM.
      const parsed = await mermaid.parse(preview.code, { suppressErrors: true });
      if (!parsed) return errorElement("invalid diagram syntax");
      diagramCounter += 1;
      const { svg } = await mermaid.render(`md-easy-mermaid-${diagramCounter}`, preview.code);
      const el = document.createElement("div");
      el.className = "mermaid-preview";
      el.innerHTML = svg;
      return el;
    });
    if (element && !superseded()) show(preview, element);
  } catch (err) {
    if (!superseded()) show(preview, errorElement(err instanceof Error ? err.message : String(err)));
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
  const preview: LivePreview = {
    id: ++previewCounter,
    code,
    apply: applyPreview,
    theme: currentTheme(),
    settled: false,
    generation: 0,
  };
  livePreviews.add(preview);
  schedulePrune();
  watchDocumentTheme();
  const loading = loadingElement();
  loading.dataset.mermaidPreview = String(preview.id);
  void renderInto(preview);
  return loading;
}
