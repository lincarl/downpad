// @vitest-environment jsdom
// Crepe keeps an empty paragraph after a final list, code block, quote, table,
// rule or image so there is a line to type on. These tests use the real editor
// to check that a copy leaves it out, and that a copied line keeps its line break.

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
// Crepe's cursor measures the selection, and jsdom has no layout for text ranges.
Range.prototype.getClientRects = () => document.body.getClientRects();
Range.prototype.getBoundingClientRect = () => document.body.getBoundingClientRect();

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown` and return its editable element. */
async function open(markdown: string): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const editable = root.querySelector<HTMLElement>(".ProseMirror");
  if (!editable) throw new Error("no editor");
  return editable;
}

/** Send a clipboard event of `type` to the editor, backed by `clipboard`. */
function sendClipboardEvent(editable: HTMLElement, type: "copy" | "paste", clipboard: Map<string, string>): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      clearData: () => clipboard.clear(),
      setData: (format: string, data: string) => clipboard.set(format, data),
      getData: (format: string) => clipboard.get(format) ?? "",
      files: [],
      items: [],
    },
  });
  editable.dispatchEvent(event);
}

/** Copy the editor's selection, returning the clipboard. */
function copy(editable: HTMLElement): Map<string, string> {
  const clipboard = new Map<string, string>();
  sendClipboardEvent(editable, "copy", clipboard);
  return clipboard;
}

/** Select the whole document with Ctrl+A and copy it, returning the clipboard. */
function copyAll(editable: HTMLElement): Map<string, string> {
  editable.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
  return copy(editable);
}

/** Select from the start of paragraph `from` to the start of paragraph `to`, as
 *  a mouse drag or Shift with the arrow keys would. */
function selectLines(editable: HTMLElement, from: number, to: number): void {
  const paragraphs = editable.querySelectorAll("p");
  editable.focus();
  document.getSelection()?.setBaseAndExtent(paragraphs[from], 0, paragraphs[to], 0);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("copying the whole document", () => {
  it.each([
    ["a quote", "Intro.\n\n> Quote\n", /<\/blockquote>$/],
    ["a list", "Intro.\n\n- A\n- B\n", /<\/ul>$/],
    ["a code block", "Intro.\n\n```js\nlet x = 1;\n```\n", /<\/pre>$/],
  ])("leaves out the empty line Crepe keeps after %s", { timeout: 60_000 }, async (_name, markdown, htmlEnd) => {
    const editable = await open(markdown);
    const clipboard = copyAll(editable);
    // Selecting everything made Crepe add the line.
    expect(editable.lastElementChild?.tagName).toBe("P");
    expect(editable.lastElementChild?.textContent).toBe("");
    expect(clipboard.get("text/plain")).toBe(markdown);
    expect(clipboard.get("text/html")).toMatch(htmlEnd);
  });

  it("keeps an empty last line typed after a paragraph", { timeout: 60_000 }, async () => {
    // Crepe adds no line after a paragraph, so this one carries a copied line break.
    const editable = await open("Intro.\n\n<br />\n");
    expect(editable.lastElementChild?.textContent).toBe("");
    const clipboard = copyAll(editable);
    expect(clipboard.get("text/html")).toMatch(/<p><\/p>$/);
  });

  it("keeps a last paragraph", { timeout: 60_000 }, async () => {
    const clipboard = copyAll(await open("Intro.\n\nLast line.\n"));
    expect(clipboard.get("text/plain")).toBe("Intro.\n\nLast line.\n");
    expect(clipboard.get("text/html")).toMatch(/<p>Last line.<\/p>$/);
  });
});

describe("copying lines", () => {
  it("leaves out the empty last line when the selection ends in it", { timeout: 60_000 }, async () => {
    const editable = await open("Intro.\n\n> Quote\n");
    // Any change of selection makes Crepe add the line. Ctrl+Shift+End, or a drag
    // past the quote, then ends the selection in it.
    selectLines(editable, 0, 1);
    expect(editable.lastElementChild?.tagName).toBe("P");
    selectLines(editable, 0, 2);
    const clipboard = copy(editable);
    expect(clipboard.get("text/plain")).toBe("Intro.\n\n> Quote\n");
    expect(clipboard.get("text/html")).toMatch(/<\/blockquote>$/);
  });

  it("keeps the line break of a whole line pasted before another", { timeout: 60_000 }, async () => {
    const editable = await open("Line one.\n\nLine two.\n\nTarget.\n");
    // Home and Shift+Down select a line up to the start of the next one.
    selectLines(editable, 0, 1);
    const clipboard = copy(editable);
    selectLines(editable, 2, 2);
    sendClipboardEvent(editable, "paste", clipboard);
    expect(editor?.getMarkdown()).toBe("Line one.\n\nLine two.\n\nLine one.\n\nTarget.\n");
  });
});
