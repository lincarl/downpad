// @vitest-environment jsdom
// Crepe keeps an empty paragraph after a final list, code block, quote, table,
// rule or image so there is a line to type on. These tests use the real editor
// to check that a copy leaves it out.

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

/** Select the whole document with Ctrl+A and copy it, returning the clipboard. */
function copyAll(editable: HTMLElement): Map<string, string> {
  editable.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
  const clipboard = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      clearData: () => clipboard.clear(),
      setData: (type: string, data: string) => clipboard.set(type, data),
      getData: (type: string) => clipboard.get(type) ?? "",
    },
  });
  editable.dispatchEvent(event);
  return clipboard;
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

  it("keeps a last paragraph", { timeout: 60_000 }, async () => {
    const clipboard = copyAll(await open("Intro.\n\nLast line.\n"));
    expect(clipboard.get("text/plain")).toBe("Intro.\n\nLast line.\n");
    expect(clipboard.get("text/html")).toMatch(/<p>Last line.<\/p>$/);
  });
});
