// @vitest-environment jsdom
// Exercise Crepe's real handle, menu and commands. Only hit testing is stubbed
// because jsdom cannot lay out the editor or find a block under the pointer.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { redo, undo } from "@milkdown/kit/prose/history";
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

/** Empty a row without changing its block type. */
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

/** Keep edits in one history window without freezing Crepe's debounce timers. */
function keepHistoryTogether(view: EditorView): void {
  const dispatch = view.dispatch;
  const time = Date.now();
  vi.spyOn(view, "dispatch").mockImplementation((tr) => dispatch(tr.setTime(time)));
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

  it.each([
    { markdown: "", dismiss: "Escape" },
    { markdown: "", dismiss: "blur" },
    { markdown: "##\n", dismiss: "Escape" },
    { markdown: "##\n", dismiss: "blur" },
  ])("dismisses $markdown with $dismiss without changing the document or undo history", async ({ markdown, dismiss }) => {
    const { editor, view, outside, onChange } = await open(markdown);
    const beforeMarkdown = editor.getMarkdown();
    const before = view.state.doc;
    const menu = await add(view, 0);
    if (dismiss === "Escape") key(view, "Escape");
    else outside.focus();
    expect(menu.dataset.show).toBe("false");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(view.state.doc).toBe(before);
    expect(editor.getMarkdown()).toBe(beforeMarkdown);
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

  it.each([
    { label: "Bullet List", type: "bullet_list", checked: null, markdown: "- Item" },
    { label: "Ordered List", type: "ordered_list", checked: null, markdown: "1. Item" },
    { label: "Task List", type: "bullet_list", checked: false, markdown: "- [ ] Item" },
  ].flatMap((item) => ["", item.label.split(" ")[0].toLowerCase()].map((filter) => ({ ...item, filter }))))(
    "converts an empty heading to $label with filter $filter and undoes the command",
    async ({ label, type, checked, markdown, filter }) => {
      const { editor, view } = await open("Before.\n\n## Target.\n\nAfter.\n");
      keepHistoryTogether(view);
      const pos = clearRow(view, "Target.");
      const before = view.state.doc;
      const menu = await add(view, pos);
      expect(view.state.doc).toBe(before);
      if (filter) {
        view.dispatch(view.state.tr.insertText(filter));
        await vi.waitFor(() => expect(menu.querySelectorAll("li[data-index]")).toHaveLength(1));
      }
      const beforeCommand = view.state.doc;
      pick(menu, label);
      expect(menu.dataset.show).toBe("false");
      const inserted = view.state.doc;
      expect(inserted.childCount).toBe(before.childCount);
      expect(inserted.child(0)).toBe(before.child(0));
      expect(inserted.child(2)).toBe(before.child(2));
      const list = inserted.child(1);
      expect(list.type.name).toBe(type);
      expect(list.childCount).toBe(1);
      expect(list.firstChild?.type.name).toBe("list_item");
      expect(list.firstChild?.attrs.checked).toBe(checked);
      expect(list.firstChild?.firstChild?.type.name).toBe("paragraph");
      expect(list.textContent).toBe("");
      expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(view.state.selection.$from.node(1)).toBe(list);

      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.toJSON()).toEqual(beforeCommand.toJSON());
      expect(view.state.selection.$from.parent.type.name).toBe("heading");
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(inserted)).toBe(true);
      view.dispatch(view.state.tr.insertText("Item"));
      expect(editor.getMarkdown()).toBe(`Before.\n\n${markdown}\n\nAfter.\n`);
    },
  );

  it.each([
    { prefix: "", label: "Heading 2", type: "heading", level: 2, filter: "" },
    { prefix: "## ", label: "Heading 3", type: "heading", level: 3, filter: "" },
    { prefix: "## ", label: "Text", type: "paragraph", level: undefined, filter: "" },
    { prefix: "## ", label: "Heading 3", type: "heading", level: 3, filter: "heading 3" },
  ])("undoes $label with filter $filter separately from recent edits in $prefix", async ({ prefix, label, type, level, filter }) => {
    const { view } = await open(`${prefix}Target.\n\nAfter.\n`);
    keepHistoryTogether(view);
    const original = view.state.doc;
    clearRow(view, "Target.");
    const menu = await add(view, 0);
    if (filter) {
      view.dispatch(view.state.tr.insertText(filter));
      await vi.waitFor(() => expect(menu.querySelectorAll("li[data-index]")).toHaveLength(1));
    }
    const beforeCommand = view.state.doc;
    pick(menu, label);
    const applied = view.state.doc;
    expect(applied.firstChild?.type.name).toBe(type);
    expect(applied.firstChild?.attrs.level).toBe(level);
    expect(applied.firstChild?.textContent).toBe("");
    expect(applied.child(1)).toBe(original.child(1));
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(beforeCommand)).toBe(true);
    // Earlier typing and deletion keep ProseMirror's normal grouping.
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(original)).toBe(true);
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(beforeCommand)).toBe(true);
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(applied)).toBe(true);
  });

  it("keeps edit grouping when the menu is dismissed and has no stale row for a later slash command", async () => {
    const { view } = await open("## Target.\n\n## After.\n");
    keepHistoryTogether(view);
    const original = view.state.doc;
    clearRow(view, "Target.");
    const menu = await add(view, 0);
    key(view, "Escape");
    view.dispatch(view.state.tr.insertText("Changed."));
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(original)).toBe(true);

    const pos = clearRow(view, "After.");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).insertText("/task"));
    await vi.waitFor(() => {
      expect(menu.dataset.show).toBe("true");
      expect(menu.querySelectorAll("li[data-index]")).toHaveLength(1);
    });
    const beforeCommand = view.state.doc;
    pick(menu, "Task List");
    const applied = view.state.doc;
    expect(applied.firstChild?.eq(original.firstChild!)).toBe(true);
    expect(applied.child(1).type.name).toBe("bullet_list");
    expect(applied.child(1).firstChild?.attrs.checked).toBe(false);
    expect(applied.child(1).textContent).toBe("");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(beforeCommand)).toBe(true);
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(applied)).toBe(true);
  });

  it.each([
    { name: "empty paragraph", initial: "", label: "Bullet List", expected: "- Item\n" },
    { name: "nonempty heading", initial: "## Kept.\n", label: "Ordered List", expected: "## Kept.\n\n1. Item\n" },
    { name: "existing list", initial: "- Kept.\n", label: "Task List", expected: "- Kept.\n\n* [ ] Item\n" },
  ])("keeps $name list insertion behavior", async ({ initial, label, expected }) => {
    const { editor, view } = await open(initial);
    const before = view.state.doc;
    const pos = row(view, initial ? "Kept." : "");
    const menu = await add(view, pos);
    pick(menu, label);
    expect(menu.dataset.show).toBe("false");
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.$from.node(2).type.name).toBe("list_item");
    if (initial) expect(view.state.doc.firstChild?.eq(before.firstChild!)).toBe(true);
    view.dispatch(view.state.tr.insertText("Item"));
    expect(editor.getMarkdown()).toBe(expected);
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
