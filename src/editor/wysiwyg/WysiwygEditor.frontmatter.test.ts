// @vitest-environment jsdom
// The document view shows only the body after a frontmatter block, so it has no
// way to show the blank lines between the two, or the missing line break after a
// block that ends the file. These tests use the real editor to check that the
// Markdown keeps those lines as the file had them and starts new body text on
// its own line.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor, type WysiwygCallbacks } from "./WysiwygEditor";

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
async function open(markdown: string, showFrontmatterPanel = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn<WysiwygCallbacks["onChange"]>();
  const settings = { ...DEFAULT_SETTINGS, showFrontmatterPanel };
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(settings), {
    getSettings: () => settings,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, onChange, root };
}

/** Wait past the 200ms change report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Edit the body through a real transaction, as Find and replace does. */
function appendToFirstLine(ed: WysiwygEditor): void {
  const opts = { caseSensitive: true, wholeWord: false, regex: false };
  ed.search("First line.", opts);
  ed.replaceAll("First line. Typed.", "First line.", opts);
}

describe("the lines between frontmatter and the body", () => {
  it.each([
    ["one blank line", "---\ntitle: x\n---\n\nFirst line.\n"],
    ["two blank lines", "---\ntitle: x\n---\n\n\nFirst line.\n"],
    ["no blank line", "---\ntitle: x\n---\nFirst line.\n"],
    ["a closing ... line and a blank line", "---\ntitle: x\n...\n\nFirst line.\n"],
  ])("keeps %s when the file opens and after a body edit", { timeout: 60_000 }, async (_name, markdown) => {
    const { editor, onChange } = await open(markdown);
    expect(editor.getMarkdown()).toBe(markdown);
    appendToFirstLine(editor);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(markdown.replace("First line.", "First line. Typed."));
  });

  it("keeps them with the frontmatter table hidden", { timeout: 60_000 }, async () => {
    const markdown = "---\ntitle: x\n---\n\nFirst line.\n";
    const { editor, onChange } = await open(markdown, false);
    expect(editor.getMarkdown()).toBe(markdown);
    appendToFirstLine(editor);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: x\n---\n\nFirst line. Typed.\n");
  });

  it("keeps them after a frontmatter table edit", { timeout: 60_000 }, async () => {
    const { onChange, root } = await open("---\ntitle: x\n---\n\nFirst line.\n");
    await settle();
    const value = root.querySelector<HTMLElement>(".frontmatter-value-edit")!;
    value.textContent = "y";
    fireEvent.input(value);
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: y\n---\n\nFirst line.\n");
  });

  it("keeps them when the split mirrors a Markdown pane edit", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("Start.\n");
    await settle();
    editor.setMarkdown("---\ntitle: x\n---\n\nFirst line.\n");
    expect(editor.getMarkdown()).toBe("---\ntitle: x\n---\n\nFirst line.\n");
    appendToFirstLine(editor);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: x\n---\n\nFirst line. Typed.\n");
  });

  it("starts body text on its own line after frontmatter that ends the file", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("---\ntitle: x\n---");
    expect(editor.getMarkdown()).toBe("---\ntitle: x\n---");
    editor.insertMarkdown("Hello");
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: x\n---\nHello\n");
  });
});
