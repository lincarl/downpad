// @vitest-environment jsdom
// Text is saved with the escapes it needs to read back the same, and spaces at
// its end stay plain spaces that never make a hard line break. These tests use
// the real editor to check md-easy's text handler (serializer.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";

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

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<WysiwygEditor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return editor;
}

const PLAIN_TEXT: FindOptions = { caseSensitive: true, wholeWord: false, regex: false };

describe("escapes in text that ends in a space", () => {
  it.each([
    ["a character reference", "&amp;copy; **bold**\n", "\\&copy; **bold**\n"],
    ["a literal tag", "&lt;b&gt; text **bold**\n", "\\<b> text **bold**\n"],
    ["an escaped heading marker", "\\# not a heading **b**\n", "\\# not a heading **b**\n"],
    [
      "an escaped pipe in a table cell",
      "| a |\n| - |\n| x \\| y **z** |\n",
      "| a            |\n| ------------ |\n| x \\| y **z** |\n",
    ],
  ])("keeps %s before bold text", { timeout: 60_000 }, async (_name, markdown, expected) => {
    // An opened file can be reported as its exact text until it changes, so
    // edit the first line to make the editor write the whole body.
    const editor = await open(`Edit.\n\n${markdown}`);
    editor.search("Edit.", PLAIN_TEXT);
    editor.replaceAll("Edited.", "Edit.", PLAIN_TEXT);
    expect(editor.getMarkdown()).toBe(`Edited.\n\n${expected}`);
  });

  it.each([
    // Not `word&#x20;`, which is why Milkdown has its own text handler.
    ["writes a space added at the end as a plain space", "word\n", "word", "word ", "word \n"],
    // The space is dropped when the file is read, so the `#` then ends the
    // heading and would be read as a closing marker.
    ["escapes a # before a space added at the end of a heading", "# Ticket \\#\n", "#", "# ", "# Ticket \\# \n"],
    // Two spaces before a line ending would be read as a hard line break.
    [
      "keeps a soft line break after two spaces added before it",
      "Line a*b\nline two\n",
      "a*b",
      "a*b  ",
      "Line a\\*b \nline two\n",
    ],
  ])("%s", { timeout: 60_000 }, async (_name, markdown, query, replacement, expected) => {
    const editor = await open(markdown);
    editor.search(query, PLAIN_TEXT);
    editor.replaceAll(replacement, query, PLAIN_TEXT);
    expect(editor.getMarkdown()).toBe(expected);
  });
});
