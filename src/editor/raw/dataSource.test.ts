// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { highlightTree, tags as t } from "@lezer/highlight";
import { dataHighlightStyle, dataSource } from "./dataSource";
import { RawEditor } from "./RawEditor";

/** The highlight classes at the first occurrence of a text in `doc`, read as
 *  `language`. */
function tokens(language: "json" | "yaml", doc: string): { get(text: string): string } {
  const tree = dataSource(language).language.parser.parse(doc);
  const ranges: Array<[number, number, string]> = [];
  highlightTree(tree, dataHighlightStyle, (from, to, classes) => ranges.push([from, to, classes]));
  return {
    get(text) {
      const at = doc.indexOf(text);
      if (at < 0) throw new Error(`"${text}" is not in the document`);
      return ranges.find(([from, to]) => from <= at && at < to)?.[2] ?? "";
    },
  };
}

describe("JSON colours", () => {
  it("colours property names, strings, numbers and constants apart", () => {
    const map = tokens("json", '{ "name": "Downpad", "count": 12, "on": true, "none": null }\n');
    const classes = ['"name"', '"Downpad"', "12", "true"].map((text) => map.get(text));
    for (const value of classes) expect(value).not.toBe("");
    expect(new Set(classes).size).toBe(4);
    // true and null are both constants.
    expect(map.get("null")).toBe(map.get("true"));
    // Punctuation keeps the body colour.
    expect(map.get("{")).toBe("");
    expect(map.get(":")).toBe("");
  });
});

describe("YAML colours", () => {
  it("colours keys, plain and quoted values, comments and anchors apart", () => {
    const map = tokens("yaml", '# Settings\nname: Downpad\ntitle: "Quoted"\nbase: &base\n  port: 80\n');
    const classes = ["# Settings", "name", "Downpad", '"Quoted"', "&base"].map((text) => map.get(text));
    for (const value of classes) expect(value).not.toBe("");
    expect(new Set(classes).size).toBe(5);
    // A nested key is a key too, and a number is a plain value.
    expect(map.get("port")).toBe(map.get("name"));
    expect(map.get("80")).toBe(map.get("Downpad"));
  });

  it("reads a text that Markdown would read as a heading and a list as YAML", () => {
    const map = tokens("yaml", "# not a heading\nitems:\n  - one\n");
    expect(map.get("# not a heading")).toBe(dataHighlightStyle.style([t.comment]));
    expect(map.get("not a heading")).toBe(dataHighlightStyle.style([t.comment]));
    expect(map.get("items")).not.toBe(map.get("one"));
  });
});

describe("RawEditor languages", () => {
  const editors: RawEditor[] = [];
  const mount = (text: string, language?: "markdown" | "json" | "yaml"): { editor: RawEditor; view: EditorView; onChange: ReturnType<typeof vi.fn> } => {
    const editor = new RawEditor();
    const onChange = vi.fn();
    editor.mount(document.createElement("div"), text, { onChange }, { language });
    editors.push(editor);
    return { editor, view: (editor as unknown as { view: EditorView }).view, onChange };
  };
  const topNode = (view: EditorView): string => syntaxTree(view.state).topNode.name;

  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
  });

  it("parses the text as the language it is mounted with, and as Markdown without one, and names the editor by it", () => {
    const label = (view: EditorView): string | null => view.contentDOM.getAttribute("aria-label");
    const jsonView = mount('{"a": 1}\n', "json").view;
    expect(topNode(jsonView)).toBe("JsonText");
    expect(label(jsonView)).toBe("JSON source editor");
    expect(topNode(mount("a: 1\n", "yaml").view)).toBe("Stream");
    const markdownView = mount("# Title\n").view;
    expect(topNode(markdownView)).toBe("Document");
    expect(label(markdownView)).toBe("Markdown source editor");
  });

  it("only a Markdown document has prose whose spelling can be checked", async () => {
    const { editor } = mount('{"speling": "mistaek"}\n', "json");
    expect(editor.hasProse()).toBe(false);
    await expect(editor.checkSpelling()).rejects.toThrow("Only a Markdown document");
    editor.setSpellcheck(true);
    expect((editor as unknown as { view: EditorView }).view.contentDOM.getAttribute("spellcheck")).toBe("false");
    expect(mount("# Title\n").editor.hasProse()).toBe(true);
  });

  it("switches language in place, keeping the text, the caret and the undo history, and reporting no change", () => {
    const { editor, view, onChange } = mount("a: 1\n", "markdown");
    view.dispatch({ changes: { from: 0, insert: "b: 2\n" }, selection: { anchor: 3 } });
    onChange.mockClear();

    editor.setLanguage("yaml");

    expect(topNode(view)).toBe("Stream");
    expect(view.contentDOM.getAttribute("aria-label")).toBe("YAML source editor");
    expect(editor.getText()).toBe("b: 2\na: 1\n");
    expect(view.state.selection.main.head).toBe(3);
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.hasProse()).toBe(false);

    editor.setLanguage("markdown");
    expect(topNode(view)).toBe("Document");
    expect(editor.hasProse()).toBe(true);
  });

  it("turns native spelling on again for a document that becomes Markdown, and off for one that becomes data", () => {
    const { editor, view } = mount("# Title\n");
    editor.setSpellcheck(true);
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
    editor.setLanguage("json");
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
    editor.setLanguage("markdown");
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });
});
