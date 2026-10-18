// @vitest-environment jsdom
// A document Crepe cannot create, with the real editor. Milkdown leaves a failed
// create in its creating state, so the mount must not wait for Milkdown's
// destroy, which retries every 50 ms while an editor is creating.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<void> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
}

describe("a document Crepe cannot create", () => {
  it("rejects the mount instead of never settling, and leaves no retry timer", { timeout: 20_000 }, async () => {
    // Nesting this deep overflows the Markdown parser's stack.
    await expect(open(">".repeat(10_000) + " deep\n")).rejects.toThrow(RangeError);

    const timeouts = vi.spyOn(globalThis, "setTimeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Milkdown's destroy on an editor stuck creating schedules itself again
    // every 50 ms.
    expect(timeouts.mock.calls.filter(([, delay]) => delay === 50)).toEqual([]);
  });
});
