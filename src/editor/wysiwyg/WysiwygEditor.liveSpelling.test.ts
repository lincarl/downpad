// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { spellingAt } from "../spelling";
import { WysiwygEditor } from "./WysiwygEditor";

vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });
const metadataHighlights = new Map<string, Set<Range>>();
vi.stubGlobal("Highlight", class extends Set<Range> {});
vi.stubGlobal("CSS", { ...globalThis.CSS, highlights: metadataHighlights });

const editors: WysiwygEditor[] = [];
const native = {
  checkSpelling: vi.fn(async (words: string[]) => words.filter((word) => word === "speling")),
  spellingSuggestions: vi.fn(async () => ["spelling"]),
  listen: vi.fn(() => () => {}),
  invoke: vi.fn(async () => {}),
};

beforeEach(() => {
  Object.defineProperty(window, "downpadDesktop", { configurable: true, value: native });
  native.checkSpelling.mockClear();
});

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  delete window.downpadDesktop;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "caretPositionFromPoint");
});

/** Mount the real document editor with a deterministic native dictionary. */
async function open(markdown: string, showFrontmatterPanel = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new WysiwygEditor();
  const onChange = vi.fn();
  editors.push(editor);
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => ({ ...DEFAULT_SETTINGS, spellCheckEnabled: true, showFrontmatterPanel }),
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view: EditorView = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  if (root.querySelector(".frontmatter-table-wrap")) {
    await vi.waitFor(() => expect(root.querySelector(".frontmatter-content")).not.toBeNull());
  }
  return { editor, root, view, onChange };
}

describe("live Document spelling", () => {
  it("checks initial content and a changed word without a trailing space", { timeout: 60_000 }, async () => {
    const { editor, root, view } = await open("speling\n");
    await vi.waitFor(() => expect(root.querySelector(".md-spelling-error")?.textContent).toBe("speling"));
    expect(view.dom.getAttribute("spellcheck")).toBe("false");
    view.dispatch(view.state.tr.insertText("l", 4));
    await vi.waitFor(() => expect(root.querySelector(".md-spelling-error")).toBeNull());
    view.dispatch(view.state.tr.delete(4, 5));
    await vi.waitFor(() => expect(root.querySelector(".md-spelling-error")?.textContent).toBe("speling"));
    editor.setSpellcheck(false);
    expect(root.querySelector(".md-spelling-error")).toBeNull();
  });

  it("keeps selection and history untouched and corrects split formatting with undo", { timeout: 60_000 }, async () => {
    const { editor, root, view, onChange } = await open("before sp**el**ing after\n\n`speling`\n\n```\nspeling\n```\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 4)));
    const before = view.state.doc;
    const selection = view.state.selection;
    expect(await editor.checkSpelling()).toBe(1);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection).toBe(selection);
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect([...root.querySelectorAll(".md-spelling-error")].map((el) => el.textContent).join("")).toBe("speling");

    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 9, inside: 0 });
    const choice = await spellingAt(view.dom, 0, 0);
    await choice?.replace("spelling");
    expect(view.state.doc.firstChild?.textContent).toBe("before spelling after");
    expect(root.querySelector("strong")?.textContent).toContain("el");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it("counts collapsed and hidden metadata values without changing text or selection", { timeout: 60_000 }, async () => {
    const markdown = '---\ntyppokey: speling # commenttyppo\ndescription: "speling"\nflag: false\nlist: [opaquetyppo]\n---\n\nspeling\n';
    const { editor, root, view, onChange } = await open(markdown);
    const doc = view.state.doc;
    const selection = view.state.selection;
    const table = root.querySelector(".frontmatter-table");
    const html = table?.innerHTML;
    expect(root.querySelector(".frontmatter-content")?.hasAttribute("hidden")).toBe(true);
    expect(await editor.checkSpelling()).toBe(3);
    expect(editor.getMarkdown()).toBe(markdown);
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection).toBe(selection);
    expect(table?.innerHTML).toBe(html);
    expect([...metadataHighlights.get("md-spelling-metadata") ?? []].map((range) => range.toString())).toEqual(["speling", "speling"]);
    expect(onChange).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>(".frontmatter-toggle")?.click();
    expect(await editor.checkSpelling()).toBe(3);
    expect(undo(view.state, view.dispatch)).toBe(false);

    const hidden = await open(markdown, false);
    expect(hidden.root.querySelector(".frontmatter-table")).toBeNull();
    expect(await hidden.editor.checkSpelling()).toBe(3);
  });

  it("corrects a metadata value safely, preserves body marks and supports undo", { timeout: 60_000 }, async () => {
    const markdown = '---\ntitle: "speling" # keep this comment\n---\n\nspeling\n';
    const { editor, root, view } = await open(markdown);
    root.querySelector<HTMLButtonElement>(".frontmatter-toggle")?.click();
    await editor.checkSpelling();
    const cell = root.querySelector<HTMLElement>('.frontmatter-value-edit[data-line="0"]')!;
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true, value: () => ({ offsetNode: cell.firstChild, offset: 3 }),
    });
    const choice = await spellingAt(cell, 0, 0);
    expect(choice?.word).toBe("speling");
    await choice?.replace("spelling");
    expect(editor.getMarkdown()).toBe(markdown.replace('"speling"', '"spelling"'));
    expect(root.querySelector(".ProseMirror .md-spelling-error")?.textContent).toBe("speling");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
    await expect(choice?.replace("spelling")).rejects.toThrow("word changed");
  });

  it("rejects a correction that would break YAML quoting", { timeout: 60_000 }, async () => {
    const markdown = '---\ntitle: "speling"\n---\n\nBody\n';
    const { editor, root } = await open(markdown);
    const cell = root.querySelector<HTMLElement>(".frontmatter-value-edit")!;
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: cell.firstChild, offset: 3 }) });
    native.spellingSuggestions.mockResolvedValueOnce(['spelling"']);
    const choice = await spellingAt(cell, 0, 0);
    await expect(choice?.replace('spelling"')).rejects.toThrow("metadata format");
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("waits for metadata composition and preserves the cell caret while marking its changed word", { timeout: 60_000 }, async () => {
    const { editor, root } = await open("---\ntitle: spelling\n---\n\nBody\n");
    await editor.checkSpelling();
    native.checkSpelling.mockClear();
    const cell = root.querySelector<HTMLElement>(".frontmatter-value-edit")!;
    cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    cell.textContent = "speling";
    cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(native.checkSpelling).not.toHaveBeenCalled();
    const caret = document.createRange();
    caret.setStart(cell.firstChild!, 7);
    caret.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(caret);
    cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(native.checkSpelling).toHaveBeenCalledWith(["speling"]));
    expect([...metadataHighlights.get("md-spelling-metadata") ?? []].map((range) => range.toString())).toEqual(["speling"]);
    expect(cell.innerHTML).toBe("speling");
    expect(document.getSelection()?.anchorNode).toBe(cell.firstChild);
    expect(document.getSelection()?.anchorOffset).toBe(7);
  });
});
