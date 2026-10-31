// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { redo, undo } from "@milkdown/kit/prose/history";
import { AllSelection, TextSelection } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});
Range.prototype.getClientRects = () => document.body.getClientRects();
Range.prototype.getBoundingClientRect = () => document.body.getBoundingClientRect();

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the real document editor and expose its selection and undo history. */
async function open(markdown = "") {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { editor, view, root, onChange };
}

/** Dispatch a clipboard paste through the real plugin ordering. */
function paste(view: EditorView, text: string, html = ""): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "",
      files: [],
      items: [],
    },
  });
  view.dom.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

const DOCUMENT = '---\ntitle: "Pasted source"\ntags: [one, two]\n---\n\n\nHeading\n=======\n\n* item\n\nSee [docs][ref].\n\n[ref]: https://example.test\n';

/** Select the first occurrence of text in the rendered document. */
function selectText(view: EditorView, text: string): void {
  let found = false;
  view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(text);
    if (at >= 0) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + at, pos + at + text.length)));
      found = true;
    }
    return false;
  });
  expect(found).toBe(true);
}

describe("Markdown source pasted into the document", () => {
  it("keeps frontmatter and body exact, including highlighted HTML, and undoes them together", async () => {
    const { editor, view, root, onChange } = await open();
    paste(view, DOCUMENT.replace(/\n/g, "\r\n"), `<pre><code>${DOCUMENT}</code></pre>`);
    expect(editor.getMarkdown()).toBe(DOCUMENT);
    expect(root.querySelector(".frontmatter-toggle")).not.toBeNull();
    expect(view.dom.querySelector("h1")?.textContent).toBe("Heading");
    expect(view.dom.textContent).not.toContain("title:");
    editor.reportPendingChange();
    expect(onChange).toHaveBeenLastCalledWith(DOCUMENT);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("");
    expect(root.querySelector(".frontmatter-toggle")).toBeNull();
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(DOCUMENT);
  });

  it("recognizes frontmatter with no body or other Markdown markers", async () => {
    const { editor, view, root } = await open();
    paste(view, "---\ntitle: only metadata\n...");
    expect(editor.getMarkdown()).toBe("---\ntitle: only metadata\n...");
    expect(root.querySelector(".frontmatter-toggle")).not.toBeNull();
    expect(view.dom.textContent).toBe("");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("");
  });

  it("replaces a selected body and preserves existing frontmatter", async () => {
    const initial = "---\ntitle: keep\n---\n\nOld body.\n";
    const { editor, view } = await open(initial);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    paste(view, "# New body\n\n* original marker");
    expect(editor.getMarkdown()).toBe("---\ntitle: keep\n---\n\n# New body\n\n* original marker");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(initial);
  });

  it("places the caret after pasted frontmatter that remains body content below existing metadata", async () => {
    const initial = "---\ntitle: keep\n---\n\nOld body.\n";
    const { editor, view } = await open(initial);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    paste(view, "---\ntitle: pasted\n---\n\n# New body");
    expect(editor.getMarkdown()).toBe("---\ntitle: keep\n---\n\n---\ntitle: pasted\n---\n\n# New body");
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.dom.querySelector("h1")?.textContent).toBe("New body!");
    expect(view.state.doc.textContent).toContain("title: pasted");
  });

  it("replaces the selected text, leaves the caret after it, and separates following typing in undo", async () => {
    const { editor, view } = await open("Before target after.\n\nUntouched\n=========\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 14)));
    paste(view, "__new__");
    expect(editor.getMarkdown()).toBe("Before __new__ after.\n\nUntouched\n=========\n");
    expect(view.state.selection.from).toBe(11);
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.state.doc.firstChild?.textContent).toBe("Before new! after.");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("Before __new__ after.\n\nUntouched\n=========\n");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("Before target after.\n\nUntouched\n=========\n");
  });

  it("keeps ordinary prose and rich prose on the existing paste path", async () => {
    const { editor, view } = await open();
    paste(view, "plain words");
    expect(view.state.doc.textContent).toBe("plain words");
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    paste(view, "bold words", "<p><strong>bold words</strong></p>");
    expect(editor.getMarkdown()).toBe("**bold words**\n");
  });

  it.each([
    ["**", "strong"], ["*", "em"], ["~~", "del"],
  ])("keeps %s text on both sides when pasted Markdown uses the same mark", async (delimiter, tag) => {
    const initial = `Before ${delimiter}left target right${delimiter} after.\n`;
    const { editor, view } = await open(initial);
    selectText(view, "target");
    paste(view, `${delimiter}new${delimiter}`);
    expect(view.dom.querySelector(tag)?.textContent).toBe("left new right");
    expect(view.state.doc.textContent).toBe("Before left new right after.");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(initial);
  });

  it("puts the caret after the entire paste when it repeats selected and surrounding text", async () => {
    const { view } = await open("Before target after.\n");
    selectText(view, "target");
    paste(view, "target **after**.");
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.state.doc.textContent).toBe("Before target after.! after.");
  });

  it("tracks the source endpoint when pasted blocks join the surrounding text", async () => {
    const { view } = await open("Before target after.\n");
    selectText(view, "target");
    paste(view, "# Heading\n\n* item");
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.dom.querySelector("li")?.textContent?.trim()).toBe("item! after.");
    expect(view.dom.querySelector("p")?.textContent).toBe("Before # Heading");
  });

  it("keeps a pasted image inline inside marked text and types immediately after it", async () => {
    const { editor, view } = await open("Before **left target right** after.\n");
    selectText(view, "target");
    paste(view, "![Image](image.png)");
    expect(view.state.doc.childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("Before **left ![Image](image.png) right** after.\n");
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.state.doc.textContent).toBe("Before left ! right after.");
    expect(view.dom.querySelector("p img")?.getAttribute("alt")).toBe("Image");
  });

  it("preserves unselected marks around a paste that adds paragraphs", async () => {
    const { view } = await open("Before **left target right** after.\n");
    selectText(view, "target");
    paste(view, "**one**\n\n**two**");
    view.dispatch(view.state.tr.insertText("!"));
    expect([...view.dom.querySelectorAll("p")].map((node) => node.textContent)).toEqual(["Before left one", "two! right after."]);
    expect([...view.dom.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["left one", "two! right"]);
  });

  it.each([
    [2, 3, ["AB", "XY", "keepthese"]],
    [0, 3, ["XY", "onetwo", "keepthese"]],
  ])("pastes a table into selected cells %s to %s without changing unselected cells", async (from, to, expected) => {
    const { editor, view } = await open("| A | B |\n| - | - |\n| first | second |\n| keep | these |\n");
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "table_cell" || node.type.name === "table_header") cells.push(pos);
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[from]!, cells[to]!)));
    paste(view, "| X | Y |\n| --- | --- |\n| one | two |");
    expect(view.dom.querySelectorAll("table.children")).toHaveLength(1);
    expect([...view.dom.querySelectorAll("tr")].map((row) => row.textContent)).toEqual(expected);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("| A | B |\n| - | - |\n| first | second |\n| keep | these |\n");
  });

  it("repeats inline Markdown across selected header and body cells", async () => {
    const { view } = await open("| A | B |\n| - | - |\n| first | second |\n");
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "table_cell" || node.type.name === "table_header") cells.push(pos);
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[2]!)));
    paste(view, "**new**");
    expect([...view.dom.querySelectorAll("tr")].map((row) => row.textContent)).toEqual(["newB", "newsecond"]);
    expect(view.dom.querySelectorAll("strong")).toHaveLength(2);
  });

  it.each([
    ["link", "Before [target](https://example.test) after.\n", "Before [__new__](https://example.test) after.\n"],
    ["emphasis", "Before *target* after.\n", "Before *__new__* after.\n"],
  ])("pastes inside %s text without losing its surrounding mark", async (_name, initial, expected) => {
    const { editor, view } = await open(initial);
    selectText(view, "target");
    paste(view, "__new__");
    expect(editor.getMarkdown()).toBe(expected);
    expect(view.dom.querySelector("strong")?.textContent).toBe("new");
    expect(view.dom.querySelector("a, em")?.textContent).toContain("new");
  });

  it("keeps Markdown and backticks literal when pasting inside inline code", async () => {
    const { editor, view } = await open("Before `left target right` after.\n");
    selectText(view, "target");
    paste(view, "**bold** `code`");
    expect(view.dom.querySelector("code")?.textContent).toBe("left **bold** `code` right");
    expect(view.dom.querySelector("strong")).toBeNull();
    expect(editor.getMarkdown()).toBe("Before ``left **bold** `code` right`` after.\n");
  });

  it("recognizes frontmatter inserted at the start of an existing body", async () => {
    const { editor, view, root } = await open("Body stays.\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    paste(view, "---\ntitle: added\n---\n\n");
    expect(editor.getMarkdown()).toBe("---\ntitle: added\n---\n\nBody stays.\n");
    expect(root.querySelector(".frontmatter-toggle")).not.toBeNull();
    expect(view.state.doc.textContent).toBe("Body stays.");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("Body stays.\n");
  });

  it.each(["\r", "\r\n", "\n"])("recognizes frontmatter with a BOM and %j line endings", async (eol) => {
    const { editor, view, root } = await open();
    const markdown = "---\ntitle: metadata only\n---\n";
    paste(view, "\uFEFF" + markdown.replace(/\n/g, eol));
    expect(editor.getMarkdown()).toBe(markdown);
    expect(root.querySelector(".frontmatter-toggle")).not.toBeNull();
  });
});
