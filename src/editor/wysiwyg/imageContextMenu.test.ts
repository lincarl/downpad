// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { imageBlockSchema, remarkImageBlockPlugin } from "@milkdown/kit/component/image-block";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { closeContextMenu } from "../../shell/contextMenu";
import { imageBlockAltSchema } from "./imageBlockAlt";
import { imageContextMenuPlugin } from "./imageContextMenu";

let editor: Editor | null = null;
afterEach(async () => {
  closeContextMenu();
  await editor?.destroy();
  editor = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** An editor with Crepe's image block, Downpad's alt text schema and the image
 *  menu, as in WysiwygEditor. */
async function open(markdown: string): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  const context = { getSettings: () => DEFAULT_SETTINGS, getFilePath: () => null, requestSave: async () => false };
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(remarkImageBlockPlugin)
    .use(imageBlockSchema)
    .use(imageBlockAltSchema)
    .use(imageContextMenuPlugin({ current: null }, context))
    .create();
  return editor.ctx.get(editorViewCtx);
}

const currentMarkdown = () => editor?.action(getMarkdown());

/** Right-click the first standalone image. jsdom has no layout, so the
 *  pointer's document position is stubbed. */
function rightClickImage(view: EditorView): void {
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === "image-block") pos = at;
  });
  if (pos < 0) throw new Error("no image block");
  vi.spyOn(view, "posAtCoords").mockReturnValue({ pos, inside: pos });
  view.dom.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
}

describe("the image context menu", () => {
  it("deletes only the image", async () => {
    const view = await open("Before.\n\n![Diagram](images/notes.png)\n\nAfter.\n");
    rightClickImage(view);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(currentMarkdown()).toBe("Before.\n\nAfter.\n");
  });

  it("changes the alt text and keeps the image's source and title", async () => {
    const view = await open('Before.\n\n![Diagram](images/notes.png "Notes flow")\n');
    rightClickImage(view);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit alt text…" }));

    const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Alt text" });
    expect(field.value).toBe("Diagram");
    fireEvent.change(field, { target: { value: "Flow of the notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(currentMarkdown()).toBe('Before.\n\n![Flow of the notes](images/notes.png "Notes flow")\n'),
    );
  });
});
