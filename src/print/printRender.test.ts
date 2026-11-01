// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_LINE_CLASS } from "./paginate";
import { pageGeometry, type PageGeometry, type PageSetup } from "./paper";
import { renderPrintPages, type RunningHead } from "./printRender";

const EMPTY_LINE = '<p><br class="ProseMirror-trailingBreak"></p>';

/** Print a node with `className` holding `html` and return the print root. */
function printed(html: string, className = "ProseMirror"): HTMLElement {
  const documentNode = document.createElement("div");
  documentNode.className = className;
  documentNode.setAttribute("contenteditable", "true");
  documentNode.innerHTML = html;
  return renderPrintPages({
    version: "document",
    documentNode,
    markdown: "",
    geometry: pageGeometry({ paperSize: "a4", orientation: "portrait", margins: "normal", scale: 1, header: false, footer: true }),
    runningHead: { title: false, date: false, pageNumbers: true },
    docTitle: "notes.md",
    dateLabel: "",
  });
}

/** Print a `.ProseMirror` node holding `html` and return the printed blocks. */
function printedBlocks(html: string): string[] {
  return Array.from(printed(html).querySelectorAll(".print-flow > *"), (block) => block.outerHTML);
}

/** A Crepe code block with `chrome` in it and one line with the class `line`. */
const codeBlock = (chrome = "", line = "cm-line") =>
  `<div class="milkdown-code-block">${chrome}<div class="cm-editor"><div class="cm-content"><div class="${line}">a</div></div></div></div>`;

/** A Crepe table block with `chrome` in it. */
const tableBlock = (chrome = "") =>
  `<div class="milkdown-table-block">${chrome}<table><tbody><tr><td>A</td></tr></tbody></table></div>`;

describe("the printed document", () => {
  it.each([
    ["the empty line Crepe keeps after a final list", `<p>First</p><ul><li><p>Last</p></li></ul>${EMPTY_LINE}`, ["<p>First</p>", "<ul><li><p>Last</p></li></ul>"]],
    ["every empty line at the end", `<p>First</p>${EMPTY_LINE}${EMPTY_LINE}`, ["<p>First</p>"]],
  ])("leaves out %s", (_name, html, blocks) => {
    expect(printedBlocks(html)).toEqual(blocks);
  });

  it.each([
    ["an empty line between paragraphs", `<p>A</p>${EMPTY_LINE}<p>B</p>`, ["<p>A</p>", "<p></p>", "<p>B</p>"]],
    ["a last line that holds a line break", '<p>A</p><p><br><br class="ProseMirror-trailingBreak"></p>', ["<p>A</p>", "<p><br></p>"]],
  ])("keeps %s", (_name, html, blocks) => {
    expect(printedBlocks(html)).toEqual(blocks);
  });

  it("prints a missing image without the hover text that asks for a click", () => {
    const missing = '<p>A <span class="milkdown-image-inline md-image-missing" title="Missing image. Click to locate it." data-md-path="gone.png"><img class="image-inline" src="data:," alt="Gone" title="Chart"></span></p>';

    expect(printedBlocks(missing)).toEqual([missing.replace(' title="Missing image. Click to locate it."', "")]);
  });

  it("prints the URL shown after a link as text, which a page break can split", () => {
    const link = '<a href="https://e.com/a">A</a>';
    const url = '<span class="md-link-url ProseMirror-widget" data-url="https://e.com/a" title="https://e.com/a"><!----></span>';

    expect(printedBlocks(`<h1>${link}${url}</h1>`)).toEqual([
      `<h1>${link}<span class="md-link-url ProseMirror-widget" title="https://e.com/a"> (https://e.com/a)</span></h1>`,
    ]);
  });

  it("prints an image inside the text selection without the selection's mark", () => {
    const image = '<p>A <span class="milkdown-image-inline md-image-missing md-in-selection"><img src="data:," alt="Gone"></span></p>';

    expect(printedBlocks(image)).toEqual([image.replace(" md-in-selection", "")]);
  });

  it.each([
    ["the gap cursor", '<div class="ProseMirror-gapcursor"></div><p>A</p>', "<p>A</p>"],
    ["the virtual cursor", '<span class="prosemirror-virtual-cursor"></span><p>A</p>', "<p>A</p>"],
    ["a code block's cursor layer", codeBlock('<div class="cm-cursorLayer"></div>'), codeBlock()],
    ["a code block's selection layer", codeBlock('<div class="cm-selectionLayer"></div>'), codeBlock()],
    ["a code block's fold arrows", codeBlock('<div class="cm-gutter cm-foldGutter"></div>'), codeBlock()],
    ["a code block's language picker and Copy button", codeBlock('<div class="tools"><button>Copy</button></div>'), codeBlock()],
    ["a table's drag handles", tableBlock('<div class="handle"></div>'), tableBlock()],
    ["the empty copy of a table Crepe drags", tableBlock('<div class="drag-preview"><table></table></div>'), tableBlock()],
    ...["milkdown-block-handle", "milkdown-slash-menu", "milkdown-toolbar", "milkdown-link-edit", "milkdown-link-preview"].map(
      (tag) => [`Crepe's ${tag}`, `<p>A</p><${tag}></${tag}>`, "<p>A</p>"],
    ),
    ["the mark of a selected node", '<div class="milkdown-image-block ProseMirror-selectednode"></div>', '<div class="milkdown-image-block"></div>'],
    ["the mark of the line with the caret", codeBlock("", "cm-line cm-activeLine"), codeBlock()],
    [
      "the mark of the caret line's number",
      codeBlock('<div class="cm-gutterElement cm-activeLineGutter">1</div>'),
      codeBlock('<div class="cm-gutterElement">1</div>'),
    ],
  ])("prints without %s", (_name, html, clean) => {
    expect(printedBlocks(html)).toEqual([clean]);
  });

  it("prints a document no one can edit, also inside its code blocks", () => {
    const editableCode = codeBlock().replace('class="cm-content"', 'class="cm-content" contenteditable="true"');

    expect(printed(editableCode).querySelectorAll("[contenteditable]")).toHaveLength(0);
  });

  it("prints a focused editor's document without the focus mark", () => {
    expect(printed("<p>A</p>", "ProseMirror ProseMirror-focused").querySelector(".print-flow")?.className).toBe(
      "ProseMirror print-flow",
    );
  });
});

describe("the printed sheets", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Print three lines of Markdown source and return the sheets. jsdom does no
   * layout, so each line is made as tall as a sheet's body, which puts one
   * line on each sheet at 100%.
   */
  function printSheets(
    runningHead: Partial<RunningHead> = {},
    setup: Partial<PageSetup> = {},
  ): { pages: HTMLElement[]; geometry: PageGeometry } {
    const head = { title: false, date: false, pageNumbers: true, ...runningHead };
    const geometry = pageGeometry({
      paperSize: "a4",
      orientation: "portrait",
      margins: "normal",
      scale: 1,
      header: head.title || head.date,
      footer: head.pageNumbers,
      ...setup,
    });
    const lineHeight = geometry.contentHeightPx;
    const isLine = (el: HTMLElement) => el.classList.contains(SOURCE_LINE_CLASS);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return isLine(this) ? lineHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return isLine(this) ? Array.from(this.parentElement!.children).indexOf(this) * lineHeight : 0;
    });
    const root = renderPrintPages({
      version: "markdown",
      documentNode: null,
      markdown: "one\ntwo\nthree\n",
      geometry,
      runningHead: head,
      docTitle: "notes.md",
      dateLabel: "2026-11-01",
    });
    return { pages: Array.from(root.querySelectorAll<HTMLElement>(".print-page")), geometry };
  }

  const linesOf = (page: HTMLElement) =>
    Array.from(page.querySelectorAll(`.print-page-body .${SOURCE_LINE_CLASS}`), (line) => line.textContent);
  const footerOf = (page: HTMLElement) => page.querySelector(".print-page-footer")?.textContent ?? null;
  const headerOf = (page: HTMLElement) => {
    const header = page.querySelector(".print-page-header");
    return header ? Array.from(header.children, (slot) => slot.textContent) : null;
  };

  it("numbers each sheet out of the total in its footer", () => {
    const { pages } = printSheets();

    expect(pages.map(linesOf)).toEqual([["one"], ["two"], ["three"]]);
    expect(pages.map(footerOf)).toEqual(["1 / 3", "2 / 3", "3 / 3"]);
  });

  it("prints no footer with page numbers off", () => {
    const { pages } = printSheets({ pageNumbers: false });

    expect(pages.map(footerOf)).toEqual([null, null, null]);
  });

  it.each([
    ["the title and the date", { title: true, date: true }, ["notes.md", "2026-11-01"]],
    ["the title alone", { title: true }, ["notes.md", ""]],
    ["the date alone", { date: true }, ["", "2026-11-01"]],
  ])("heads every sheet with %s", (_name, runningHead, slots) => {
    const { pages } = printSheets(runningHead);

    expect(pages.map(headerOf)).toEqual([slots, slots, slots]);
  });

  it("prints no header with the title and date off", () => {
    const { pages } = printSheets({ title: false, date: false });

    expect(pages.map(headerOf)).toEqual([null, null, null]);
  });

  it("sizes each sheet and its body to the page geometry", () => {
    const { pages, geometry } = printSheets({ title: true }, { paperSize: "letter", orientation: "landscape" });

    for (const page of pages) {
      expect(page.style.width).toBe(`${geometry.widthPx}px`);
      expect(page.style.height).toBe(`${geometry.heightPx}px`);
      const body = page.querySelector<HTMLElement>(".print-page-body")!;
      expect(body.style.top).toBe(`${geometry.contentTopPx}px`);
      expect(body.style.width).toBe(`${geometry.contentWidthPx}px`);
      expect(body.style.height).toBe(`${geometry.contentHeightPx}px`);
    }
  });

  it("lays the text out larger at 50% and scales each sheet's flow down onto the page", () => {
    const { pages, geometry } = printSheets({}, { scale: 0.5 });

    // The flow is laid out twice as tall as the page body, so two lines fit a sheet.
    expect(pages.map(linesOf)).toEqual([["one", "two"], ["three"]]);
    for (const page of pages) {
      const flow = page.querySelector<HTMLElement>(".print-flow")!;
      expect(flow.style.width).toBe(`${geometry.layoutWidthPx}px`);
      expect(flow.style.transform).toBe("scale(0.5)");
      expect(flow.style.transformOrigin).toBe("top left");
    }
  });
});
