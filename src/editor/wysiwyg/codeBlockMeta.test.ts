// @vitest-environment jsdom
// Code fences keep the info after the language, such as title="app.js", which
// documentation sites read.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { Editor, defaultValueCtx, editorViewCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { DOMParser, DOMSerializer } from "@milkdown/kit/prose/model";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { codeBlockMetaSchema } from "./codeBlockMeta";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

let editor: WysiwygEditor | null = null;
let bare: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  await bare?.destroy();
  editor = null;
  bare = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<WysiwygEditor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return editor;
}

/** Milkdown's form of the open document, which is how the editor writes a
 *  block that an edit changed. */
function written(opened: WysiwygEditor): string {
  const { crepe } = opened as unknown as { crepe: Crepe };
  return crepe.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
}

describe("code fence info", () => {
  it("keeps the info after the language when a code block is written", { timeout: 60_000 }, async () => {
    const blocks = [
      '```js title="app.js"\nlet x = 1;\n```',
      "```python {linenos=true}\nx = 1\n```",
      // A fence without info gets none, and a math block stays math.
      "```\nplain\n```",
      "$$\nE = mc^2\n$$",
      // A LaTeX fence shows LaTeX source, so it stays a fence.
      "```latex\n\\frac{a}{b}\n```",
      '```latex title="a.tex"\n\\frac{a}{b}\n```',
    ].join("\n\n");
    // An edit writes only the blocks it changes, so write the whole document
    // the way a changed block is written.
    expect(written(await open(`${blocks}\n`))).toBe(`${blocks}\n`);
  });

  it("keeps the info when a code block is copied and pasted", async () => {
    bare = await Editor.make()
      .config((ctx) => ctx.set(defaultValueCtx, '```js title="app.js"\nlet x = 1;\n```\n\n```\nplain\n```\n'))
      .use(commonmark)
      .use(codeBlockMetaSchema)
      .create();
    // ProseMirror copies through the schema's DOM output and pastes through its parse rules.
    const schema = bare.ctx.get(schemaCtx);
    const copied = DOMSerializer.fromSchema(schema).serializeFragment(bare.ctx.get(editorViewCtx).state.doc.content);
    const blocks: unknown[] = [];
    DOMParser.fromSchema(schema).parse(copied).descendants((node) => {
      if (node.type.name === "code_block") blocks.push(node.attrs);
    });
    expect(blocks).toEqual([
      { language: "js", meta: 'title="app.js"', fenced: true },
      { language: "", meta: "", fenced: true },
    ]);
  });
});
