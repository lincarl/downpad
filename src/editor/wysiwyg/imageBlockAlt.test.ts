// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, schemaCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { imageBlockComponent, imageBlockSchema, remarkImageBlockPlugin } from "@milkdown/kit/component/image-block";
import { DOMParser, type Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";
import { imageBlockAltSchema, imageBlockAltView } from "./imageBlockAlt";
import { imageAttrs } from "./imageView";

let editor: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** An editor with Crepe's image block, then Downpad's schema on top, as in WysiwygEditor. */
async function open(markdown: string): Promise<Editor> {
  editor = await Editor.make()
    .config((ctx) => ctx.set(defaultValueCtx, markdown))
    .use(commonmark)
    .use(remarkImageBlockPlugin)
    .use(imageBlockSchema)
    .use(imageBlockAltSchema)
    .create();
  return editor;
}

/** The first standalone image in the open document. */
function firstImageBlock(ed: Editor): { view: EditorView; pos: number; node: ProseNode } {
  const view = ed.ctx.get(editorViewCtx);
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === "image-block") pos = at;
  });
  const node = pos < 0 ? null : view.state.doc.nodeAt(pos);
  if (!node) throw new Error("no image block");
  return { view, pos, node };
}

describe("standalone image alt text", () => {
  it("saves the alt text and title it was opened with", async () => {
    const markdown = '![Diagram of the notes](images/notes.png)\n\n![](a.png "Caption")\n';
    const ed = await open(markdown);
    expect(ed.action(getMarkdown())).toBe(markdown);
  });

  it("keeps the alt text after the image is resized", async () => {
    const ed = await open("![Diagram](images/notes.png)\n");
    const { view, pos } = firstImageBlock(ed);
    view.dispatch(view.state.tr.setNodeAttribute(pos, "ratio", 1.5));
    expect(firstImageBlock(ed).node.attrs.ratio).toBe(1.5);
    expect(ed.action(getMarkdown())).toBe("![Diagram](images/notes.png)\n");
  });

  it("reads a numeric alt as text, not as a size", async () => {
    const ed = await open("![0.50](chart.png)\n");
    const { node } = firstImageBlock(ed);
    expect(node.attrs.alt).toBe("0.50");
    expect(node.attrs.ratio).toBe(1);
    expect(ed.action(getMarkdown())).toBe("![0.50](chart.png)\n");
  });

  it("gives the alt text to the context menu and to pasted images", async () => {
    const ed = await open('![Diagram](images/notes.png "Notes flow")\n');
    expect(imageAttrs(firstImageBlock(ed).node)).toEqual({
      src: "images/notes.png",
      alt: "Diagram",
      title: "Notes flow",
    });

    const html = document.createElement("div");
    html.innerHTML = '<img data-type="image-block" src="b.png" alt="Pasted diagram" caption="" ratio="1">';
    const pasted = DOMParser.fromSchema(ed.ctx.get(schemaCtx)).parse(html);
    expect(pasted.firstChild?.attrs.alt).toBe("Pasted diagram");
  });
});

/** An editor that draws images with Crepe's image view, as in the app. */
async function render(markdown: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(imageBlockComponent)
    .use(imageBlockAltSchema)
    .use(imageBlockAltView)
    .create();
  return editor;
}

/** The alt attribute of every drawn standalone image, once Crepe's view and the
 *  plugin have finished updating the page. */
async function drawnAlts(): Promise<(string | null)[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...document.querySelectorAll(".milkdown-image-block img")].map((img) => img.getAttribute("alt"));
}

describe("standalone image alt text for screen readers", () => {
  it("labels each image with its alt text, or its caption when it has none", async () => {
    await render('![Diagram](a.png "Notes flow")\n\n![](b.png "Only a caption")\n\n![Plain](c.png)\n');
    expect(await drawnAlts()).toEqual(["Diagram", "Only a caption", "Plain"]);
  });

  it("keeps the alt text when the caption changes", async () => {
    const ed = await render('![Diagram](a.png "Old caption")\n');
    const { view, pos } = firstImageBlock(ed);
    view.dispatch(view.state.tr.setNodeAttribute(pos, "caption", "New caption"));
    expect(await drawnAlts()).toEqual(["Diagram"]);
  });

  it("follows an edited alt text and an image that gets its source later", async () => {
    const ed = await render("![Diagram](a.png)\n");
    const { view, pos } = firstImageBlock(ed);
    view.dispatch(view.state.tr.setNodeAttribute(pos, "alt", "Renamed"));
    expect(await drawnAlts()).toEqual(["Renamed"]);

    view.dispatch(view.state.tr.setNodeAttribute(pos, "src", ""));
    expect(await drawnAlts()).toEqual([]);
    view.dispatch(view.state.tr.setNodeAttribute(pos, "src", "b.png"));
    expect(await drawnAlts()).toEqual(["Renamed"]);
  });
});
