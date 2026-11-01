// @vitest-environment jsdom
// What screen readers learn from the real document editor's task boxes and
// standalone images.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});
// jsdom has no layout, so measure ranges like an element. Crepe's virtual
// cursor measures the caret when a click on a task box moves the selection.
Range.prototype.getClientRects = () => document.body.getClientRects();
Range.prototype.getBoundingClientRect = () => document.body.getBoundingClientRect();

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown` and return its root element. */
async function open(markdown: string): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return root;
}

/** Wait past a list's first frame and the 200ms change report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** What a screen reader hears for each list item's marker. */
const markers = (root: HTMLElement) =>
  [...root.querySelectorAll(".label-wrapper svg")].map((svg) =>
    svg.getAttribute("aria-hidden") === "true" ? "hidden" : `${svg.getAttribute("role")} ${svg.getAttribute("aria-label")}`,
  );

describe("task boxes in the document editor", () => {
  it("say whether each task is done", { timeout: 60_000 }, async () => {
    const root = await open("- [ ] Open task\n- [x] Done task\n\n* Bullet\n");
    await settle();
    expect(markers(root)).toEqual(["img Not done", "img Done", "hidden"]);

    // Clicking a box toggles it, and the name follows.
    root.querySelector(".label-wrapper")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(editor?.getMarkdown()).toBe("- [x] Open task\n- [x] Done task\n\n* Bullet\n");
    expect(markers(root)).toEqual(["img Done", "img Done", "hidden"]);
  });
});

describe("standalone images in the document editor", () => {
  it("are announced by their alt text, which a resize keeps in the Markdown", { timeout: 60_000 }, async () => {
    const markdown = '![Alt text](a.png "Caption")\n';
    const root = await open(markdown);
    // Crepe's own image view gives the <img> the caption as its alt.
    await vi.waitFor(() => expect(root.querySelector(".milkdown-image-block img")?.getAttribute("alt")).toBe("Alt text"));

    // Crepe's own schema keeps the resize ratio in the alt slot, so a resize
    // once saved ![1.50](a.png "Caption").
    const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
    expect(view.state.doc.firstChild?.type.name).toBe("image-block");
    view.dispatch(view.state.tr.setNodeAttribute(0, "ratio", 1.5));
    expect(view.state.doc.firstChild?.attrs.ratio).toBe(1.5);
    expect(editor?.getMarkdown()).toBe(markdown);
  });
});
