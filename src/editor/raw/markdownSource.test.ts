// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { highlightTree, tags as t } from "@lezer/highlight";
import { markdownSource, markdownSourceStyle, sourceHighlightStyle } from "./markdownSource";

/** Look up the highlight classes at the first occurrence of a text in `doc`. */
function tokens(doc: string): { get(text: string): string } {
  const tree = markdownSource().language.parser.parse(doc);
  const ranges: Array<[number, number, string]> = [];
  highlightTree(tree, sourceHighlightStyle, (from, to, classes) => ranges.push([from, to, classes]));
  return {
    get(text) {
      const at = doc.indexOf(text);
      if (at < 0) throw new Error(`"${text}" is not in the document`);
      return ranges.find(([from, to]) => from <= at && at < to)?.[2] ?? "";
    },
  };
}

const cls = (...tags: Parameters<typeof sourceHighlightStyle.style>[0]): string =>
  sourceHighlightStyle.style(tags) ?? "";

describe("Markdown view colours", () => {
  it("colours headings, markers and inline code like VS Code", () => {
    const doc = "# Title\n\n- item\n\n> quote\n\nSome `code` here.\n";
    const map = tokens(doc);
    expect(map.get("#")).toContain(cls(t.heading));
    expect(map.get("Title")).toContain(cls(t.heading));
    expect(map.get("-")).not.toBe("");
    expect(map.get(">")).not.toBe("");
    expect(map.get("-")).not.toBe(map.get(">"));
    // The backticks share the code colour, as in VS Code's raw string scope.
    expect(map.get("`")).toBe(map.get("code"));
    expect(map.get("code")).not.toBe("");
  });

  it("gives only the link text the link colour", () => {
    const map = tokens("A [link](https://example.com) here.\n");
    const link = cls(t.link);
    expect(map.get("link")).toContain(link);
    expect(map.get("[")).not.toContain(link);
    expect(map.get("https://example.com")).toContain(cls(t.url));
    expect(map.get("https://example.com")).not.toContain(link);
  });

  it("reads GitHub tables and strikethrough, with plain table headers", () => {
    const map = tokens("| Name |\n| --- |\n| ~~Cell~~ |\n");
    expect(map.get("Name")).not.toContain(cls(t.heading));
    expect(map.get("Cell")).toContain(cls(t.strikethrough));
  });

  it("colours HTML entities apart from strings", () => {
    const map = tokens('A &amp; B [link](u "Title")\n');
    expect(map.get("&amp;")).toContain(cls(t.character));
    expect(map.get("&amp;")).not.toBe(map.get("Title"));
  });

  it("leaves fenced code in the body colour", () => {
    expect(tokens("```\nplain code\n```\n").get("plain code")).toBe("");
  });

  it("reads a leading --- block as frontmatter, not a heading", () => {
    const map = tokens("---\ntitle: Notes\ntags:\n  - draft\n---\n\nBody\n");
    expect(map.get("title")).not.toBe(map.get("Notes"));
    expect(map.get("title")).toBe(map.get("tags"));
    expect(map.get("Notes")).toBe(map.get("draft"));
    expect(map.get("Notes")).not.toContain(cls(t.heading));
  });

  it("keeps a later --- as a horizontal rule", () => {
    const map = tokens("Intro\n\n---\ntitle: Notes\n");
    expect(map.get("title: Notes")).toBe("");
  });
});

describe("Markdown view find highlights", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("marks every match and the selected one while a query is set", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "one two one three one",
        extensions: [search(), markdownSourceStyle()],
      }),
    });
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "one" })),
      selection: { anchor: 8, head: 11 },
    });
    expect(view.dom.querySelectorAll(".md-find-match")).toHaveLength(3);
    expect(view.dom.querySelectorAll(".md-find-current")).toHaveLength(1);
    expect(view.dom.querySelector(".md-find-current")?.textContent).toBe("one");

    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    expect(view.dom.querySelectorAll(".md-find-match")).toHaveLength(0);
  });

  it("marks a match that runs past the end of the rendered lines", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "line\n".repeat(5000), extensions: [search(), markdownSourceStyle()] }),
    });
    // Each match spans a line break, so the last rendered line's match ends
    // in the first line that is not rendered.
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "e\\nl" })) });
    const lines = view.dom.querySelectorAll(".cm-line");
    const lastMark = lines[lines.length - 1].lastElementChild;
    expect(view.viewport.to).toBeLessThan(view.state.doc.length);
    expect(lastMark?.classList.contains("md-find-match")).toBe(true);
    expect(lastMark?.textContent).toBe("e");
  });
});
