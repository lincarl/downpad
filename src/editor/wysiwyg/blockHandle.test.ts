// @vitest-environment jsdom
// Exercise Crepe's real handle, menu and commands. Only hit testing is stubbed
// because jsdom cannot lay out the editor or find a block under the pointer.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Mount the real document editor and wait for its handle to attach. */
async function open(markdown: string) {
  const root = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(root, outside);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  await vi.waitFor(() => expect(root.querySelector(".milkdown-block-handle")).not.toBeNull());
  return { editor, root, view, outside, onChange };
}

/** Find a paragraph or heading by its exact text, returning its block position. */
function row(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos;
  });
  if (found < 0) throw new Error(`Row not found: ${text}`);
  return found;
}

/** Empty a row without deleting the paragraph that holds it. */
function clearRow(view: EditorView, text: string): number {
  const pos = row(view, text);
  view.dispatch(view.state.tr.delete(pos + 1, pos + 1 + text.length));
  return pos;
}

/** Move over a row using Crepe's real block lookup, with layout supplied by jsdom stubs. */
async function hover(view: EditorView, pos: number): Promise<HTMLElement> {
  const element = view.nodeDOM(pos) as HTMLElement;
  document.elementFromPoint = () => element;
  vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: pos + 1, inside: pos });
  view.dom.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
  return vi.waitFor(() => {
    const handle = view.dom.parentElement!.querySelector<HTMLElement>('.milkdown-block-handle[data-show="true"]');
    if (!handle) throw new Error("The block handle is not shown");
    return handle;
  });
}

/** Press and release a real Crepe control, including the icon inside it. */
function click(control: Element): void {
  const target = control.querySelector("svg") ?? control;
  for (const type of ["pointerdown", "pointerup"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
}

/** Open the handle's menu and wait past its debounced eligibility check. */
async function add(view: EditorView, pos: number, menuVisible = true): Promise<HTMLElement> {
  const handle = await hover(view, pos);
  click(handle.querySelector(".operation-item")!);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const menu = view.dom.parentElement!.querySelector<HTMLElement>(".milkdown-slash-menu")!;
  expect(menu.dataset.show).toBe(String(menuVisible));
  expect(view.hasFocus()).toBe(true);
  return menu;
}

/** Choose an existing slash-menu command by its visible label. */
function pick(menu: HTMLElement, label: string): void {
  const option = [...menu.querySelectorAll("li[data-index]")].find((item) => item.textContent?.trim() === label);
  if (!option) throw new Error(`Menu option not found: ${label}`);
  click(option);
}

/** Send a key through the editor and Crepe's window-level menu listener. */
function key(view: EditorView, name: string): void {
  view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

describe("the block handle's + button", () => {
  it("keeps the only empty row and applies a menu command through the keyboard", async () => {
    const { editor, view } = await open("");
    const before = view.state.doc;
    const menu = await add(view, 0);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection.from).toBe(1);
    expect(editor.getMarkdown()).toBe("");

    key(view, "ArrowDown");
    key(view, "ArrowDown");
    key(view, "Enter");
    expect(menu.dataset.show).toBe("false");
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.attrs.level).toBe(2);
    view.dispatch(view.state.tr.insertText("Title"));
    expect(editor.getMarkdown()).toBe("## Title\n");
  });

  it("uses the hovered empty row even when the caret is in another row", async () => {
    const { editor, view } = await open("Before.\n\nTarget.\n\nAfter.\n");
    const pos = clearRow(view, "Target.");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const before = view.state.doc;
    const menu = await add(view, pos);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection.from).toBe(pos + 1);
    pick(menu, "Heading 3");
    expect(view.state.doc.childCount).toBe(before.childCount);
    expect(view.state.doc.child(1).type.name).toBe("heading");
    view.dispatch(view.state.tr.insertText("Middle"));
    expect(editor.getMarkdown()).toBe("Before.\n\n### Middle\n\nAfter.\n");
  });

  it.each(["Escape", "blur"])("dismisses with %s without changing the document or undo history", async (dismiss) => {
    const { editor, view, outside, onChange } = await open("");
    const before = view.state.doc;
    const menu = await add(view, 0);
    if (dismiss === "Escape") key(view, "Escape");
    else outside.focus();
    expect(menu.dataset.show).toBe("false");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(view.state.doc).toBe(before);
    expect(editor.getMarkdown()).toBe("");
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(view.state, view.dispatch)).toBe(false);
  });

  it("reuses an empty heading without changing its type just to open the menu", async () => {
    const { view } = await open("##\n");
    const before = view.state.doc;
    await add(view, 0);
    expect(view.state.doc).toBe(before);
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.selection.from).toBe(1);
  });

  it("still inserts after a nonempty row even when the caret is in an empty row", async () => {
    const { editor, view } = await open("Before.\n\nTarget.\n\nAfter.\n");
    const empty = clearRow(view, "Target.");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, empty + 1)));
    const before = view.state.doc;
    const menu = await add(view, 0);
    expect(view.state.doc.childCount).toBe(before.childCount + 1);
    expect(view.state.doc.firstChild?.textContent).toBe("Before.");
    expect(view.state.selection.from).toBe(before.firstChild!.nodeSize + 1);
    pick(menu, "Heading 2");
    view.dispatch(view.state.tr.insertText("Added"));
    expect(editor.getMarkdown()).toBe("Before.\n\n## Added\n\n<br />\n\nAfter.\n");
  });

  it.each(["space", "hard break"])("does not treat a row containing a %s as empty", async (content) => {
    const { view } = await open("");
    if (content === "space") view.dispatch(view.state.tr.insertText(" "));
    else view.dispatch(view.state.tr.insert(1, view.state.schema.nodes.hardbreak.create()));
    const before = view.state.doc;
    await add(view, 0);
    expect(view.state.doc.childCount).toBe(before.childCount + 1);
    expect(view.state.doc.firstChild).toBe(before.firstChild);
    expect(view.state.selection.from).toBe(before.firstChild!.nodeSize + 1);
  });

  it.each([
    { name: "list", markdown: "- Target.\n- Kept.\n", container: "list_item", menuVisible: true },
    { name: "nested list", markdown: "- Outer.\n  - Target.\n  - Kept.\n", container: "list_item", menuVisible: false },
    { name: "quote", markdown: "> Target.\n\nAfter.\n", container: "blockquote", menuVisible: true },
    { name: "table", markdown: "| Heading |\n| --- |\n| Target. |\n\nAfter.\n", container: "table", menuVisible: true },
  ])("keeps the existing container insertion for an empty row in a $name", async ({ markdown, container, menuVisible }) => {
    const { view } = await open(markdown);
    const pos = clearRow(view, "Target.");
    const before = view.state.doc;
    const $pos = before.resolve(pos);
    let depth = $pos.depth;
    while (depth > 0 && $pos.node(depth).type.name !== container) depth--;
    expect(depth).toBeGreaterThan(0);
    const end = $pos.after(depth);
    await add(view, pos, menuVisible);
    // Crepe adds after the container, never in the original empty paragraph.
    expect(view.state.doc.eq(before)).toBe(false);
    expect(view.state.doc.nodeAt(pos)?.content.size).toBe(0);
    expect(view.state.selection.from).toBeGreaterThanOrEqual(end);
  });

  it("keeps Crepe's insertion for an empty continuation paragraph inside a list item", async () => {
    const { view } = await open("- Before.\n\n  Target.\n\n- Kept.\n");
    const pos = clearRow(view, "Target.");
    const before = view.state.doc;
    const item = before.resolve(pos).parent;
    expect(item.type.name).toBe("list_item");
    await add(view, pos, false);
    expect(view.state.doc.nodeAt(pos)?.content.size).toBe(0);
    expect(view.state.selection.from).toBe(pos + 3);
    expect(view.state.selection.$from.node(2).childCount).toBe(item.childCount + 1);
  });
});
