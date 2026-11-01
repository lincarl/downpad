import { describe, it, expect, vi } from "vitest";
import { Store } from "./store";
import type { AppState } from "./types";
import { DEFAULT_SETTINGS } from "../settings/defaults";

function makeStore(): Store {
  const doc = {
    markdown: "hello",
    filePath: null,
    isDirty: false,
    savedMarkdown: "hello",
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const initial: AppState = {
    view: "wysiwyg",
    sessionId: "test-session",
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
    started: false,
  };
  return new Store(initial);
}

describe("Store", () => {
  it("notifies subscribers on set", () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ view: "raw" });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.get().view).toBe("raw");
  });

  it("patchDoc merges into the doc slice without touching siblings", () => {
    const store = makeStore();
    store.patchDoc({ markdown: "changed", isDirty: true });
    expect(store.get().doc.markdown).toBe("changed");
    expect(store.get().doc.isDirty).toBe(true);
    expect(store.get().doc.filePath).toBeNull();
    expect(store.get().settings).toBe(DEFAULT_SETTINGS);
  });

  it("select fires only when the derived value changes", () => {
    const store = makeStore();
    const listener = vi.fn();
    store.select((s) => s.view, listener);
    store.patchDoc({ markdown: "x" }); // view unchanged
    expect(listener).not.toHaveBeenCalled();
    store.set({ view: "raw" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("raw", "wysiwyg");
  });

  it("unsubscribe stops notifications", () => {
    const store = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.set({ view: "raw" });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Store tabs", () => {
  const sampleDoc = (markdown: string) => ({
    markdown,
    filePath: null,
    isDirty: false,
    savedMarkdown: markdown,
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  });

  it("patchDoc keeps the active tab in sync with doc", () => {
    const store = makeStore();
    store.patchDoc({ markdown: "edited", isDirty: true });
    const active = store.get().tabs.find((t) => t.id === store.get().activeTabId);
    expect(active?.doc.markdown).toBe("edited");
    expect(active?.doc).toBe(store.get().doc); // same reference
  });

  it("addTab appends, activates, and mirrors doc", () => {
    const store = makeStore();
    const id = store.addTab(sampleDoc("second"));
    expect(store.get().tabs).toHaveLength(2);
    expect(store.get().activeTabId).toBe(id);
    expect(store.get().doc.markdown).toBe("second");
  });

  it("activateTab switches doc without losing the other tab's content", () => {
    const store = makeStore();
    const first = store.get().activeTabId!;
    const second = store.addTab(sampleDoc("second"));
    store.patchDoc({ markdown: "second-edited" });
    store.activateTab(first);
    expect(store.get().doc.markdown).toBe("hello");
    store.activateTab(second);
    expect(store.get().doc.markdown).toBe("second-edited");
  });

  it("closeTab activates a neighbour, or blanks doc when none remain", () => {
    const store = makeStore();
    const first = store.get().activeTabId!;
    const second = store.addTab(sampleDoc("second"));
    // Close the active (second) → falls back to the left neighbour (first).
    expect(store.closeTab(second)).toBe(first);
    expect(store.get().activeTabId).toBe(first);
    expect(store.get().doc.markdown).toBe("hello");
    // Close the last remaining tab → no active tab, blank doc.
    expect(store.closeTab(first)).toBeNull();
    expect(store.get().tabs).toHaveLength(0);
    expect(store.get().activeTabId).toBeNull();
    expect(store.get().doc.markdown).toBe("");
  });

  it("closeTab prefers the right neighbour of an active middle tab", () => {
    const store = makeStore();
    const second = store.addTab(sampleDoc("second"));
    const third = store.addTab(sampleDoc("third"));
    store.activateTab(second);
    expect(store.closeTab(second)).toBe(third);
    expect(store.get().activeTabId).toBe(third);
    expect(store.get().doc.markdown).toBe("third");
  });

  it("closeTab of an inactive tab keeps the active tab and its doc", () => {
    const store = makeStore();
    const first = store.get().activeTabId!;
    const second = store.addTab(sampleDoc("second"));
    const third = store.addTab(sampleDoc("third"));
    const doc = store.get().doc;
    expect(store.closeTab(first)).toBe(third);
    expect(store.get().tabs.map((t) => t.id)).toEqual([second, third]);
    expect(store.get().activeTabId).toBe(third);
    expect(store.get().doc).toBe(doc);
  });

  it("replaceActiveDoc creates a tab when none is open", () => {
    const store = makeStore();
    store.closeTab(store.get().activeTabId!);
    store.replaceActiveDoc(sampleDoc("fresh"));
    expect(store.get().tabs).toHaveLength(1);
    expect(store.get().activeTabId).not.toBeNull();
    expect(store.get().doc.markdown).toBe("fresh");
  });

  it("patchDocById edits a background tab without touching the active doc", () => {
    const store = makeStore();
    const first = store.get().activeTabId!;
    const second = store.addTab(sampleDoc("second")); // second is now active
    store.patchDocById(first, { markdown: "first-edited", isDirty: true });
    expect(store.get().tabs.find((t) => t.id === first)?.doc.markdown).toBe("first-edited");
    // The active (second) doc is left alone.
    expect(store.get().doc.markdown).toBe("second");
    expect(store.get().activeTabId).toBe(second);
  });

  it("patchDocById mirrors into doc when the patched tab is the active one", () => {
    const store = makeStore();
    const first = store.get().activeTabId!;
    store.patchDocById(first, { markdown: "active-edited" });
    expect(store.get().doc.markdown).toBe("active-edited");
    expect(store.get().doc).toBe(store.get().tabs.find((t) => t.id === first)?.doc);
  });

  it("patchDocById is a no-op for an unknown tab id", () => {
    const store = makeStore();
    store.patchDocById("nope", { markdown: "x" });
    expect(store.get().doc.markdown).toBe("hello");
    expect(store.get().tabs).toHaveLength(1);
  });
});
