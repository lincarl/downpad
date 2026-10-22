// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the real document editor and select all text to expose its toolbar. */
async function open(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const mounted = new WysiwygEditor();
  editor = mounted;
  await mounted.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (mounted as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)));
  const toolbar = await vi.waitFor(() => {
    const found = root.querySelector<HTMLElement>('.milkdown-toolbar[data-show="true"]');
    expect(found).not.toBeNull();
    return found!;
  });
  return { editor: mounted, view, toolbar };
}

/** Activate a toolbar item through Crepe's pointer handler. */
function press(toolbar: HTMLElement, label: string): void {
  const button = toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  button!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
}

describe("the document selection toolbar", () => {
  it.each([1, 2, 3, 4])("turns selected text into H%i while preserving inline formatting and undo", { timeout: 60_000 }, async (level) => {
    const original = "Some **bold** text.\n";
    const { editor, view, toolbar } = await open(original);
    expect([...toolbar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Bold", "Italic", "Strikethrough", "Inline code", "Link",
    ]);
    expect(toolbar.querySelector(`[aria-label="Heading ${level}"]`)?.classList.contains("active")).toBe(false);
    press(toolbar, `Heading ${level}`);
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.attrs.level).toBe(level);
    expect(editor.getMarkdown()).toBe(`${"#".repeat(level)} Some **bold** text.\n`);
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe("Some bold text.");
    await vi.waitFor(() => expect(toolbar.querySelector(`[aria-label="Heading ${level}"]`)?.classList.contains("active")).toBe(true));
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });

  it("shows a heading level only when all selected text blocks use it", { timeout: 60_000 }, async () => {
    const { editor, toolbar } = await open("## First\n\nSecond\n");
    expect(toolbar.querySelector('[data-toolbar-item^="heading-"].active')).toBeNull();
    press(toolbar, "Heading 3");
    expect(editor.getMarkdown()).toBe("### First\n\n### Second\n");
    await vi.waitFor(() => expect(toolbar.querySelector('[aria-label="Heading 3"]')?.classList.contains("active")).toBe(true));
    press(toolbar, "Heading 1");
    expect(editor.getMarkdown()).toBe("# First\n\n# Second\n");
  });
});
