import { describe, it, expect } from "vitest";
import { Store } from "../state/store";
import type { AppState } from "../state/types";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import {
  applyEditorMarkdown,
  applyEditorMarkdownForTab,
  loadDocument,
} from "./DocumentModel";
import { countWords } from "./wordcount";

function makeStore(markdown = "hello world"): Store {
  const doc = {
    markdown,
    filePath: null,
    isDirty: false,
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const initial: AppState = {
    view: "wysiwyg",
    sessionId: "t",
    doc,
    tabs: [{ id: "tab-1", doc }],
    activeTabId: "tab-1",
    editorLayout: "document",
    settings: DEFAULT_SETTINGS,
    find: {
      open: false,
      query: "",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      current: 0,
      total: 0,
    },
    banner: null,
    saveStatus: { lastSavedAt: null, autosaving: false },
  };
  return new Store(initial);
}

describe("applyEditorMarkdown", () => {
  it("does not mark dirty when content is unchanged (seed guard)", () => {
    const store = makeStore("same");
    applyEditorMarkdown(store, "same");
    expect(store.get().doc.isDirty).toBe(false);
  });

  it("updates markdown and marks dirty on a real change", () => {
    const store = makeStore("before");
    applyEditorMarkdown(store, "after");
    expect(store.get().doc.markdown).toBe("after");
    expect(store.get().doc.isDirty).toBe(true);
  });
});

describe("applyEditorMarkdownForTab", () => {
  it("returns false and changes nothing when content is unchanged", () => {
    const store = makeStore("same");
    const tabId = store.get().activeTabId!;
    expect(applyEditorMarkdownForTab(store, tabId, "same")).toBe(false);
    expect(store.get().doc.isDirty).toBe(false);
  });

  it("returns true and writes to the target tab on a real change", () => {
    const store = makeStore("before");
    const tabId = store.get().activeTabId!;
    expect(applyEditorMarkdownForTab(store, tabId, "after")).toBe(true);
    expect(store.get().doc.markdown).toBe("after");
    expect(store.get().doc.isDirty).toBe(true);
  });

  it("writes to a background tab without disturbing the active doc", () => {
    const store = makeStore("first");
    const background = store.get().activeTabId!;
    store.addTab({
      markdown: "second",
      filePath: null,
      isDirty: false,
      eol: "lf",
      hadBom: false,
      modifiedMs: 0,
      frontmatterCollapsed: false,
    }); // 'second' is now active; 'background' is inactive
    expect(applyEditorMarkdownForTab(store, background, "first-edited")).toBe(true);
    expect(store.get().tabs.find((t) => t.id === background)?.doc.markdown).toBe("first-edited");
    expect(store.get().doc.markdown).toBe("second"); // active untouched
  });

  it("returns false for an unknown tab id", () => {
    const store = makeStore("x");
    expect(applyEditorMarkdownForTab(store, "nope", "y")).toBe(false);
  });
});

describe("loadDocument", () => {
  it("replaces content and clears dirty, recording metadata", () => {
    const store = makeStore("old");
    store.patchDoc({ isDirty: true });
    loadDocument(store, "new content", {
      filePath: "C:/notes/a.md",
      eol: "crlf",
      hadBom: true,
    });
    const { doc } = store.get();
    expect(doc.markdown).toBe("new content");
    expect(doc.isDirty).toBe(false);
    expect(doc.filePath).toBe("C:/notes/a.md");
    expect(doc.eol).toBe("crlf");
    expect(doc.hadBom).toBe(true);
  });
});

describe("countWords", () => {
  it("counts whitespace-delimited tokens", () => {
    expect(countWords("one two three")).toBe(3);
  });
  it("returns 0 for empty / whitespace", () => {
    expect(countWords("   \n  ")).toBe(0);
  });
});
