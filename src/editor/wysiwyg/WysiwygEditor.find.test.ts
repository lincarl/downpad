// @vitest-environment jsdom
// The document view's find with a frontmatter table above the document. The
// table's keys and values join the document's matches in one list. These tests
// use the real editor.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { splitFrontmatter } from "../../document/frontmatter";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings, type Settings } from "../../state/types";
import type { FindOptions } from "./findEngine";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

// jsdom has no layout. Give text the empty boxes a browser gives hidden text,
// for code that measures a match to scroll to it.
Object.assign(Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new DOMRect(),
});

// jsdom has no isContentEditable. The table's cells are editable exactly when
// they carry the contenteditable attribute.
Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("contenteditable");
  },
});

// jsdom has no CSS Custom Highlight API. The stand-in keeps the registry, so
// the tests can read which text each highlight covers.
class FakeHighlight extends Set<AbstractRange> {}
const highlights = new Map<string, FakeHighlight>();
vi.stubGlobal("Highlight", FakeHighlight);
vi.stubGlobal("CSS", { highlights });

const OPTS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };
// A title, a nested value, a list the table shows read-only, then the body.
const FILE = "---\ntitle: Draft notes\nmeta:\n  status: draft\ntags:\n  - draft\n---\n\nThe draft body.\n";

/** Let the editor's first timers run, so change reports start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  highlights.clear();
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports, and
 *  wait for React to draw the table and for change reports to start. */
async function open(markdown: string, settings: Settings = DEFAULT_SETTINGS): Promise<{ editor: WysiwygEditor; onChange: Mock }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(settings), {
    getSettings: () => settings,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  // React draws the table after the mount. On a busy machine that can take
  // longer than any fixed wait, so wait for the table itself.
  if (settings.showFrontmatterPanel !== false && splitFrontmatter(markdown).frontmatter !== null) {
    await vi.waitFor(() => expect(root.querySelector("[data-line]")).not.toBeNull());
  }
  await settle();
  return { editor, onChange };
}

/** The text under each range of the highlight `name`. */
const painted = (name: string) => [...(highlights.get(name) ?? [])].map((range) => range.toString());
/** The document's current match, a ProseMirror decoration. */
const documentCurrent = () => [...document.querySelectorAll(".ProseMirror .md-find-current")].map((el) => el.textContent);
/** The frontmatter block of the last reported Markdown. */
const reportedFrontmatter = (onChange: Mock) => splitFrontmatter(String(onChange.mock.lastCall?.[0])).frontmatter;

describe("document view find with a frontmatter table", () => {
  it("counts the table's matches before the document's and steps through both", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE);
    const toggle = document.querySelector<HTMLButtonElement>(".frontmatter-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(editor.search("draft", OPTS)).toEqual({ total: 4, current: 1 });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(painted("md-find-current")).toEqual(["Draft"]);
    expect(painted("md-find-match")).toEqual(["draft", "draft"]);
    expect(documentCurrent()).toEqual([]);

    expect(editor.findNext()).toEqual({ total: 4, current: 2 });
    expect(editor.findNext()).toEqual({ total: 4, current: 3 });
    expect(editor.findNext()).toEqual({ total: 4, current: 4 });
    expect(painted("md-find-current")).toEqual([]);
    expect(documentCurrent()).toEqual(["draft"]);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(editor.findNext()).toEqual({ total: 4, current: 1 });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(editor.findPrev()).toEqual({ total: 4, current: 4 });
  });

  it("leaves metadata collapsed for a body-only search and reveals a hidden current match on focus", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(FILE);
    const toggle = document.querySelector<HTMLButtonElement>(".frontmatter-toggle")!;
    expect(editor.search("body", OPTS)).toEqual({ total: 1, current: 1 });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    editor.search("notes", OPTS);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    editor.focus();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector('[data-line="0"][data-part="value"]'));
    expect(window.getSelection()?.toString()).toBe("notes");
    expect(editor.getMarkdown()).toBe(FILE);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("replaces in the YAML line and moves on, past a read-only match", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(FILE);
    editor.search("draft", OPTS);
    expect(editor.replaceCurrent("final", "draft", OPTS)).toEqual({ total: 3, current: 1 });
    expect(reportedFrontmatter(onChange)).toBe("---\ntitle: final notes\nmeta:\n  status: draft\ntags:\n  - draft\n---\n");
    await vi.waitFor(() => expect(painted("md-find-current")).toEqual(["draft"]));

    expect(editor.replaceCurrent("final", "draft", OPTS)).toEqual({ total: 2, current: 1 });
    // The list item is read-only, so Replace leaves it and moves to the document.
    expect(editor.replaceCurrent("final", "draft", OPTS)).toEqual({ total: 2, current: 2 });
    expect(reportedFrontmatter(onChange)).toBe("---\ntitle: final notes\nmeta:\n  status: final\ntags:\n  - draft\n---\n");
    expect(onChange.mock.lastCall?.[0]).toContain("The draft body.");
    expect(documentCurrent()).toEqual(["draft"]);
  });

  it("replaces all in the table and the document but not in read-only YAML", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(FILE);
    editor.search("draft", OPTS);
    expect(editor.replaceAll("final", "draft", OPTS)).toEqual({ total: 1, current: 1 });
    expect(reportedFrontmatter(onChange)).toBe("---\ntitle: final notes\nmeta:\n  status: final\ntags:\n  - draft\n---\n");
    expect(onChange.mock.lastCall?.[0]).toContain("The final body.");
    await vi.waitFor(() => expect(painted("md-find-current")).toEqual(["draft"]));
    expect(painted("md-find-match")).toEqual([]);
  });

  it("paints a match typed into a table cell", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE);
    editor.search("draft", OPTS);
    const title = document.querySelector<HTMLElement>('[data-line="0"][data-part="value"]')!;
    title.textContent = "Draft notes, second draft";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(painted("md-find-match")).toEqual(["draft", "draft", "draft"]));
    expect(painted("md-find-current")).toEqual(["Draft"]);
  });

  it("shows the replaced text in a cell the user typed into", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(FILE);
    const title = document.querySelector<HTMLElement>('[data-line="0"][data-part="value"]')!;
    title.textContent = "Draft notes2";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    // Back to the text React last drew in this cell.
    editor.search("notes2", OPTS);
    editor.replaceCurrent("notes", "notes2", OPTS);
    expect(reportedFrontmatter(onChange)).toContain("title: Draft notes\n");
    await vi.waitFor(() => expect(document.querySelector('[data-line="0"][data-part="value"]')?.textContent).toBe("Draft notes"));
  });

  it("keeps no document match current while the table has it and the document changes", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE);
    editor.search("draft", OPTS);
    editor.insertMarkdown("Another draft.");
    expect(documentCurrent()).toEqual([]);
    expect(painted("md-find-current")).toEqual(["Draft"]);
  });

  it("puts the caret on a table match when the card closes, and leaves no document text selected", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(FILE);
    editor.search("draft", OPTS);
    // Step back to the body's match, which selects it, then on into the table.
    expect(editor.findPrev()).toEqual({ total: 4, current: 4 });
    expect(editor.findNext()).toEqual({ total: 4, current: 1 });
    // What the find card does on Escape.
    editor.focus();
    editor.clearSearch();
    expect(document.activeElement).toBe(document.querySelector('[data-line="0"][data-part="value"]'));
    expect(window.getSelection()?.toString()).toBe("Draft");
    // Text that reaches the document goes to a caret instead of over the body's match.
    editor.insertMarkdown("X");
    editor.reportPendingChange();
    expect(splitFrontmatter(String(onChange.mock.lastCall?.[0])).body).toContain("The draft");
  });

  it("returns focus to the document when the current table match is read-only", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE);
    editor.search("draft", OPTS);
    expect(editor.findNext()).toEqual({ total: 4, current: 2 });
    expect(editor.findNext()).toEqual({ total: 4, current: 3 });
    editor.focus();
    expect(document.activeElement).toBe(document.querySelector(".ProseMirror"));
  });

  it("removes the table's highlights when the search is cleared or the editor closes", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE);
    editor.search("draft", OPTS);
    expect(painted("md-find-current")).toEqual(["Draft"]);
    editor.clearSearch();
    expect(painted("md-find-current")).toEqual([]);
    expect(painted("md-find-match")).toEqual([]);
    expect(editor.findNext()).toEqual({ total: 0, current: 0 });

    editor.search("draft", OPTS);
    expect(painted("md-find-match")).toEqual(["draft", "draft"]);
    await editor.destroy();
    expect(painted("md-find-current")).toEqual([]);
    expect(painted("md-find-match")).toEqual([]);
  });

  it("keeps another document's table highlights when one that searched before closes", { timeout: 60_000 }, async () => {
    const { editor: first } = await open(FILE);
    first.search("draft", OPTS);
    first.clearSearch();
    const { editor: second } = await open(FILE.replace("Draft notes", "Other draft"));
    second.search("draft", OPTS);
    await first.destroy();
    expect(painted("md-find-current")).toEqual(["draft"]);
    expect(painted("md-find-match")).toEqual(["draft", "draft"]);
  });

  it("leaves the frontmatter out when the table is turned off", { timeout: 60_000 }, async () => {
    const { editor } = await open(FILE, { ...DEFAULT_SETTINGS, showFrontmatterPanel: false });
    expect(editor.search("draft", OPTS)).toEqual({ total: 1, current: 1 });
    expect(documentCurrent()).toEqual(["draft"]);
    expect(highlights.size).toBe(0);
  });

  it("steps and replaces in a document without frontmatter as before", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("One draft.\n\nTwo draft.\n");
    expect(editor.search("draft", OPTS)).toEqual({ total: 2, current: 1 });
    expect(editor.findNext()).toEqual({ total: 2, current: 2 });
    expect(documentCurrent()).toEqual(["draft"]);
    expect(editor.replaceCurrent("final", "draft", OPTS)).toEqual({ total: 1, current: 1 });
    editor.reportPendingChange();
    expect(onChange.mock.lastCall?.[0]).toBe("One draft.\n\nTwo final.\n");
    expect(highlights.size).toBe(0);
  });
});
