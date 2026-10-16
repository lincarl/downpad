// @vitest-environment jsdom
// Crepe keeps an empty paragraph after a final list, code block, quote, table,
// rule or image so there is a line to type on. These tests use the real editor
// to check that this line never reaches the Markdown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; onChange: ReturnType<typeof vi.fn> }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, onChange };
}

/** Wait past a list's first frame and the 200ms change report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The reported Markdown that differs from `markdown`. */
const differing = (onChange: ReturnType<typeof vi.fn>, markdown: string) =>
  onChange.mock.calls.map(([reported]) => reported as string).filter((reported) => reported !== markdown);

describe("the empty line Crepe keeps at the end", () => {
  it.each([
    // Crepe's list view adds the line a frame after the list is drawn.
    ["a list", "First line.\n\n- Last item\n"],
    // Any later change adds it, even a selection or clearing find highlights.
    ["a code block", "First line.\n\n```js\nlet x = 1;\n```\n"],
    // The heading id update adds it while the editor opens.
    ["a quote after a heading", "# Notes\n\nFirst line.\n\n> Quote\n"],
    // A rule or image has no content either, but it is not an empty line.
    ["a rule", "First line.\n\n---\n"],
    ["a standalone image", "First line.\n\n![Alt](picture.png)\n"],
    // An empty line inside the list keeps its <br /> form.
    ["a list that ends in an empty line", "- A\n\n  <br />\n"],
    // An empty line between paragraphs is not the end of the document.
    ["paragraphs around an empty line", "Hello\n\n<br />\n\nWorld\n"],
  ])("leaves the Markdown of a file that ends in %s unchanged", { timeout: 60_000 }, async (_name, markdown) => {
    const { editor, onChange } = await open(markdown);
    expect(editor.getMarkdown()).toBe(markdown);
    await settle();
    editor.clearSearch();
    await settle();
    expect(editor.getMarkdown()).toBe(markdown);
    expect(differing(onChange, markdown)).toEqual([]);
  });

  it("drops only the last of two empty lines at the end of an edited file", { timeout: 60_000 }, async () => {
    const { editor } = await open("Hello\n\n<br />\n\n<br />\n");
    // An unedited file keeps its exact text, so edit it first.
    const options = { caseSensitive: true, wholeWord: false, regex: false };
    editor.search("Hello", options);
    editor.replaceAll("Hi", "Hello", options);
    expect(editor.getMarkdown()).toBe("Hi\n\n<br />\n");
  });

  it("mirrors a split edit that ends in a list without an extra blank line", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("Start.\n");
    await settle();
    editor.setMarkdown("First line.\n\n- Last item\n");
    expect(editor.getMarkdown()).toBe("First line.\n\n- Last item\n");
    await settle();
    expect(differing(onChange, "First line.\n\n- Last item\n")).toEqual([]);
  });
});
