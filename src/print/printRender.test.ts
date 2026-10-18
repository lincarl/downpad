// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pageGeometry } from "./paper";
import { renderPrintPages } from "./printRender";

const EMPTY_LINE = '<p><br class="ProseMirror-trailingBreak"></p>';

/** Print a `.ProseMirror` node holding `html` and return the printed blocks. */
function printedBlocks(html: string): string[] {
  const documentNode = document.createElement("div");
  documentNode.className = "ProseMirror";
  documentNode.innerHTML = html;
  const root = renderPrintPages({
    version: "document",
    documentNode,
    markdown: "",
    geometry: pageGeometry({ paperSize: "a4", orientation: "portrait", margins: "normal", scale: 1, header: false, footer: true }),
    runningHead: { title: false, date: false, pageNumbers: true },
    docTitle: "notes.md",
    dateLabel: "",
  });
  return Array.from(root.querySelectorAll(".print-flow > *"), (block) => block.outerHTML);
}

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

  it("prints an image inside the text selection without the selection's mark", () => {
    const image = '<p>A <span class="milkdown-image-inline md-image-missing md-in-selection"><img src="data:," alt="Gone"></span></p>';

    expect(printedBlocks(image)).toEqual([image.replace(" md-in-selection", "")]);
  });
});
