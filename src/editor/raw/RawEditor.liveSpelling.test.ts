// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { DocumentLanguage } from "../../files/documentLanguage";
import { spellingAt } from "../spelling";
import { RawEditor } from "./RawEditor";

const editors: RawEditor[] = [];
const native = {
  checkSpelling: vi.fn(async (words: string[]): Promise<string[]> => words.filter((word) => word === "speling")),
  spellingSuggestions: vi.fn(async () => ["spelling"]),
  listen: vi.fn(() => () => {}),
  invoke: vi.fn(async () => {}),
};

beforeEach(() => {
  Object.defineProperty(window, "downpadDesktop", { configurable: true, value: native });
  native.checkSpelling.mockClear();
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  delete window.downpadDesktop;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Mount an actual CodeMirror editor with a deterministic native dictionary. */
function open(source: string, language?: DocumentLanguage) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new RawEditor();
  const onChange = vi.fn();
  editor.mount(root, source, { onChange }, { language });
  editors.push(editor);
  editor.setSpellcheck(true);
  const { view } = editor as unknown as { view: EditorView };
  return { editor, root, view, onChange };
}

describe("live Markdown spelling", () => {
  it("checks a changed unfinished word and clears a corrected word", async () => {
    const { editor, root, view } = open("spelling");
    await editor.checkSpelling();
    view.dispatch({ changes: { from: 3, to: 4 } });
    await vi.waitFor(() => expect(root.querySelector(".md-spelling-error")?.textContent).toBe("speling"));
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
    view.dispatch({ changes: { from: 3, insert: "l" } });
    await vi.waitFor(() => expect(root.querySelector(".md-spelling-error")).toBeNull());
  });

  it("preserves the model, selection and undo when checking, and corrects with normal undo", async () => {
    const { editor, root, view, onChange } = open("before sp**el**ing after");
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    const before = view.state.doc;
    const selection = view.state.selection;
    expect(await editor.checkSpelling()).toBe(1);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection).toBe(selection);
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(view)).toBe(false);
    expect([...root.querySelectorAll(".md-spelling-error")].map((el) => el.textContent).join("")).toBe("speling");

    vi.spyOn(view, "posAtCoords").mockReturnValue(8);
    const choice = await spellingAt(view.contentDOM, 0, 0);
    await choice?.replace("spelling");
    expect(editor.getText().replaceAll("**", "")).toBe("before spelling after");
    expect(editor.getText().match(/\*\*/g)).toHaveLength(2);
    expect(undo(view)).toBe(true);
    expect(editor.getText()).toBe("before sp**el**ing after");
  });

  it("scans offscreen prose, excludes code and clears decorations when disabled", async () => {
    const { editor, root } = open("correct paragraph\n\n".repeat(700) + "speling\n\n```\nspeling\n```\n");
    expect(await editor.checkSpelling()).toBe(1);
    expect(native.checkSpelling.mock.calls.flatMap(([words]) => words).filter((word) => word === "speling")).toHaveLength(1);
    editor.setSpellcheck(false);
    expect(root.querySelector(".md-spelling-error")).toBeNull();
    await expect(editor.checkSpelling()).rejects.toThrow("turned off");
  });

  it("removes emptied formatting during a correction and restores it with undo", async () => {
    const { editor, view } = open("hell**l**o");
    native.checkSpelling.mockResolvedValueOnce(["helllo"]);
    native.spellingSuggestions.mockResolvedValueOnce(["hello"]);
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    const choice = await spellingAt(view.contentDOM, 0, 0);
    expect(choice?.word).toBe("helllo");
    await choice?.replace("hello");
    expect(editor.getText()).toBe("hello");
    expect(undo(view)).toBe(true);
    expect(editor.getText()).toBe("hell**l**o");
  });

  it("checks metadata values and rejects corrections that would break YAML", async () => {
    const markdown = '---\ntitle: "speling"\n---\n\ncorrect';
    const { editor, view } = open(markdown);
    expect(await editor.checkSpelling()).toBe(1);
    vi.spyOn(view, "posAtCoords").mockReturnValue(markdown.indexOf("speling") + 2);
    native.spellingSuggestions.mockResolvedValueOnce(['spelling"']);
    const choice = await spellingAt(view.contentDOM, 0, 0);
    await expect(choice?.replace('spelling"')).rejects.toThrow("metadata format");
    expect(editor.getText()).toBe(markdown);
  });
});

describe("live spelling of a text file", () => {
  const text = "---\nspeling: draft\n---\n\nThe `speling` and *speling* stay as typed.\n";

  it("checks the whole text as prose, with no Markdown code or metadata left out", async () => {
    const { editor, root } = open(text, "text");
    expect(await editor.checkSpelling()).toBe(3);
    expect([...root.querySelectorAll(".md-spelling-error")].map((el) => el.textContent)).toEqual(["speling", "speling", "speling"]);
  });

  it.each([
    ["in what Markdown would read as metadata", text.indexOf("speling"), "---\nspelling: draft\n---\n\nThe `speling` and *speling* stay as typed.\n"],
    ["in what Markdown would read as code", text.indexOf("`speling`") + 3, "---\nspeling: draft\n---\n\nThe `spelling` and *speling* stay as typed.\n"],
    ["between what Markdown would read as emphasis marks", text.indexOf("*speling*") + 3, "---\nspeling: draft\n---\n\nThe `speling` and *spelling* stay as typed.\n"],
  ])("corrects a word %s, changing only its letters", async (_where, at, expected) => {
    const { editor, view } = open(text, "text");
    await editor.checkSpelling();
    vi.spyOn(view, "posAtCoords").mockReturnValue(at);
    const choice = await spellingAt(view.contentDOM, 0, 0);
    expect(choice?.word).toBe("speling");
    await choice?.replace("spelling");
    expect(editor.getText()).toBe(expected);
  });

  const marked = (root: HTMLElement): string[] => [...root.querySelectorAll(".md-spelling-error")].map((el) => el.textContent ?? "");

  it("marks a word in what was Markdown code once the document is saved as a text file", async () => {
    const { editor, root } = open("The `speling` stays.\n");
    expect(await editor.checkSpelling()).toBe(0);
    editor.setLanguage("text");
    await vi.waitFor(() => expect(marked(root)).toEqual(["speling"]));
  });

  it("clears the mark of a word in Markdown code once a text file is saved as Markdown", async () => {
    const { editor, root } = open("The `speling` stays, and speling too.\n", "text");
    expect(await editor.checkSpelling()).toBe(2);
    editor.setLanguage("markdown");
    await vi.waitFor(() => expect(marked(root)).toEqual(["speling"]));
    expect(root.querySelector(".md-spelling-error")?.closest(".cm-line")?.textContent).toBe("The `speling` stays, and speling too.");
  });

  it("checks nothing in a JSON file", async () => {
    const { editor, root } = open('{"title": "speling"}\n', "json");
    await expect(editor.checkSpelling()).rejects.toThrow("no spelling to check");
    expect(root.querySelector(".md-spelling-error")).toBeNull();
  });
});
