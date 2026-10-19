// Builds the actual printed sheets (spec §5.21). The elements produced here are
// the ONE artifact used for both the on-screen preview in the print workspace and
// the paper output — the preview just shows them scaled down — so what the user
// approves is exactly what the printer receives.
//
// Each sheet is a fixed-size `.print-page` carrying its own running header and
// footer, with the document flow packed into the content box by paginate.ts.

import { SOURCE_LINE_CLASS, splitIntoPages } from "./paginate";
import type { PageGeometry, PrintVersion } from "./paper";

export interface RunningHead {
  /** Show the document title (its file name) in the header. */
  title: boolean;
  /** Show today's date in the header. */
  date: boolean;
  /** Show "n / total" in the footer. */
  pageNumbers: boolean;
}

export interface RenderRequest {
  version: PrintVersion;
  /** A rendered `.ProseMirror` node to print (cloned, never mutated). */
  documentNode: Element | null;
  /** Canonical markdown, printed as source for the "markdown" version. */
  markdown: string;
  geometry: PageGeometry;
  runningHead: RunningHead;
  /** Document name for the running header, e.g. "notes.md". */
  docTitle: string;
  /** Formatted date for the running header. */
  dateLabel: string;
}

/**
 * Editor-only nodes that must never reach paper: the caret and selection layers
 * both editors paint, the code-block fold arrows, Crepe's table drag handles, and
 * the affordances Crepe mounts as custom elements (block-edit.css, toolbar.css,
 * link-tooltip.css). The code-block *line numbers* are deliberately kept — they
 * are part of how the editor renders a code block, which is what the Document
 * version promises.
 */
const EDITOR_CHROME = [
  ".ProseMirror-trailingBreak",
  ".ProseMirror-gapcursor",
  ".prosemirror-virtual-cursor",
  ".cm-cursorLayer",
  ".cm-selectionLayer",
  ".cm-foldGutter",
  ".milkdown-table-block .handle",
  // Crepe's drag ghost: an empty copy of the table it mounts inside the block.
  ".milkdown-table-block .drag-preview",
  // Crepe's code-block toolbar (language picker + Copy button). It is in flow, so
  // leaving it in would also make every code block measure taller than it prints.
  ".milkdown-code-block .tools",
  "milkdown-block-handle",
  "milkdown-slash-menu",
  "milkdown-toolbar",
  "milkdown-link-edit",
  "milkdown-link-preview",
].join(", ");

/** Classes that only mark *where the user is*, not what the document says. */
const FOCUS_CLASSES = [
  "ProseMirror-focused",
  "ProseMirror-selectednode",
  // An inline image inside the text selection (imageView.ts).
  "md-in-selection",
  "cm-activeLine",
  "cm-activeLineGutter",
];

/** Strip editor-only artifacts that shouldn't appear in a printout, including
 *  the empty line Crepe keeps at the end of the document. */
export function sanitize(el: Element): Element {
  el.removeAttribute("contenteditable");
  el.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  el.querySelectorAll(EDITOR_CHROME).forEach((n) => n.remove());
  el.classList.remove(...FOCUS_CLASSES);
  for (const cls of FOCUS_CLASSES) {
    el.querySelectorAll(`.${cls}`).forEach((n) => n.classList.remove(cls));
  }
  // A missing inline image's hover text asks for a click, which does nothing here.
  el.querySelectorAll(".md-image-missing").forEach((n) => n.removeAttribute("title"));
  dropTrailingEmptyLines(el);
  return el;
}

/**
 * Remove the empty paragraphs at the end of a document. Crepe keeps one after a
 * final list, code block, quote, table, rule or image so there is a line to type
 * on. Saved Markdown leaves it out, and on paper it prints nothing but can push
 * a blank last sheet. Removing all of them, not only the last, gives the same
 * result when a print job's node is sanitized again for each render. Runs after
 * the chrome is gone, so ProseMirror's placeholder <br> no longer counts as
 * content.
 */
function dropTrailingEmptyLines(doc: Element): void {
  for (let last = doc.lastElementChild; last?.tagName === "P" && !last.hasChildNodes(); last = doc.lastElementChild) {
    last.remove();
  }
}

/**
 * Render the document into page elements inside a fresh `.print-root`.
 *
 * The flow is laid out once in an off-screen host at the page content width, then
 * split between blocks; the caller owns the returned root (append it where it
 * should be shown, remove it when done).
 */
export function renderPrintPages(req: RenderRequest): HTMLElement {
  const { geometry } = req;
  const root = document.createElement("div");
  root.className = "print-root";

  const measure = document.createElement("div");
  measure.className = "print-measure";
  // Slack around the flow so the surface's own padding can never squeeze it: the
  // flow carries an explicit width, and that width has to be identical here and
  // on the finished page or the measured breaks wouldn't match the print.
  measure.style.width = `${geometry.layoutWidthPx + 200}px`;
  const surface = printSurface(req.version);
  const flow = flowElement(req);
  flow.style.width = `${geometry.layoutWidthPx}px`;
  surface.appendChild(flow);
  measure.appendChild(surface);
  document.body.appendChild(measure);

  try {
    const groups = splitIntoPages(flow, geometry.layoutHeightPx);
    groups.forEach((blocks, index) => {
      root.appendChild(buildPage(req, flow, blocks, index, groups.length));
    });
  } finally {
    measure.remove();
  }
  return root;
}

/** How many sheets a rendered root holds (shown in the workspace header). */
export function pageCount(root: HTMLElement): number {
  return root.querySelectorAll(".print-page").length;
}

/** `.print-doc` carries the print colour/type rules; `.milkdown` re-applies Crepe's
 *  document typography to the cloned nodes so the printout matches the editor. */
function printSurface(version: PrintVersion): HTMLElement {
  const surface = document.createElement("div");
  surface.className = version === "markdown" ? "print-doc print-source" : "print-doc milkdown";
  return surface;
}

/** The single block container everything is measured in and split out of. */
function flowElement(req: RenderRequest): HTMLElement {
  if (req.version === "markdown") return markdownFlow(req.markdown);
  const flow = document.createElement("div");
  if (req.documentNode) {
    const clone = sanitize(req.documentNode.cloneNode(true) as Element) as HTMLElement;
    // Keep the source node's classes (`.ProseMirror`, Crepe's editor classes) so
    // the descendant selectors that style the document still match.
    flow.className = clone.className;
    flow.append(...Array.from(clone.childNodes));
  }
  flow.classList.add("print-flow");
  return flow;
}

/** Markdown source as one block per line, so page breaks land between lines. A
 *  line that wraps past a page is split between its wrapped lines (paginate.ts). */
function markdownFlow(markdown: string): HTMLElement {
  const flow = document.createElement("div");
  flow.className = "print-flow";
  for (const line of markdown.replace(/\n$/, "").split("\n")) {
    const el = document.createElement("div");
    el.className = SOURCE_LINE_CLASS;
    // A blank line still has to occupy a line box on the page.
    el.textContent = line === "" ? "​" : line;
    flow.appendChild(el);
  }
  return flow;
}

function buildPage(
  req: RenderRequest,
  flow: HTMLElement,
  blocks: Element[],
  index: number,
  total: number,
): HTMLElement {
  const { geometry, runningHead } = req;
  const page = document.createElement("div");
  page.className = "print-page";
  page.style.width = `${geometry.widthPx}px`;
  page.style.height = `${geometry.heightPx}px`;

  if (runningHead.title || runningHead.date) {
    const header = document.createElement("div");
    header.className = "print-page-header";
    header.style.top = `${geometry.marginPx}px`;
    header.style.left = `${geometry.marginPx}px`;
    header.style.right = `${geometry.marginPx}px`;
    header.style.height = `${geometry.headerBandPx}px`;
    header.append(span(runningHead.title ? req.docTitle : ""), span(runningHead.date ? req.dateLabel : ""));
    page.appendChild(header);
  }

  const body = document.createElement("div");
  body.className = "print-page-body";
  body.style.top = `${geometry.contentTopPx}px`;
  body.style.left = `${geometry.marginPx}px`;
  body.style.width = `${geometry.contentWidthPx}px`;
  body.style.height = `${geometry.contentHeightPx}px`;

  const surface = printSurface(req.version);
  const pageFlow = flow.cloneNode(false) as HTMLElement;
  pageFlow.style.width = `${geometry.layoutWidthPx}px`;
  if (geometry.scale !== 1) {
    pageFlow.style.transform = `scale(${geometry.scale})`;
    pageFlow.style.transformOrigin = "top left";
  }
  for (const block of blocks) pageFlow.appendChild(block);
  surface.appendChild(pageFlow);
  body.appendChild(surface);
  page.appendChild(body);

  if (runningHead.pageNumbers) {
    const footer = document.createElement("div");
    footer.className = "print-page-footer";
    footer.style.bottom = `${geometry.marginPx}px`;
    footer.style.left = `${geometry.marginPx}px`;
    footer.style.right = `${geometry.marginPx}px`;
    footer.style.height = `${geometry.footerBandPx}px`;
    footer.textContent = `${index + 1} / ${total}`;
    page.appendChild(footer);
  }
  return page;
}

function span(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}
