import { describe, expect, it } from "vitest";
import { blankDoc, type BannerState } from "../state/types";
import { createAppStore } from "./createAppStore";
import { clearNoticesOfOtherDocuments } from "./noticeScope";

const notice: BannerState = { kind: "error", message: "Downpad could not save “notes.md”." };

function setup() {
  const store = createAppStore();
  store.patchDoc({ filePath: "/docs/notes.md", markdown: "# Notes\n", savedMarkdown: "# Notes\n" });
  const stop = clearNoticesOfOtherDocuments(store);
  store.set({ banner: notice });
  return { store, stop, first: store.get().activeTabId! };
}

describe("the document a notice is about", () => {
  it("keeps the notice while the same document stays in front, also when it is shown again", () => {
    const { store, first } = setup();
    store.patchDoc({ markdown: "# Edited\n", isDirty: true, modifiedMs: 200 });
    store.replaceActiveDoc({ ...blankDoc(), filePath: "/docs/notes.md", markdown: "# From disk\n", savedMarkdown: "# From disk\n" });
    store.activateTab(first);
    expect(store.get().banner).toBe(notice);
  });

  it.each([
    { change: "another tab comes to the front", act: (store: ReturnType<typeof createAppStore>) => { store.addTab({ ...blankDoc(), filePath: "/docs/other.md" }); } },
    { change: "the tab gets another file, as through Save As", act: (store: ReturnType<typeof createAppStore>) => { store.patchDoc({ filePath: "/docs/renamed.md" }); } },
    { change: "the tab takes a file that was opened", act: (store: ReturnType<typeof createAppStore>) => { store.replaceActiveDoc({ ...blankDoc(), filePath: "/docs/opened.md" }); } },
    { change: "the last tab closes", act: (store: ReturnType<typeof createAppStore>) => { store.closeTab(store.get().activeTabId!); } },
  ])("clears the notice at once when $change", ({ act }) => {
    const { store } = setup();
    act(store);
    expect(store.get().banner).toBeNull();
  });

  it("clears the notice when another untitled tab comes to the front, which has no file to tell it by", () => {
    const store = createAppStore();
    clearNoticesOfOtherDocuments(store);
    store.set({ banner: notice });
    store.addTab(blankDoc());
    expect(store.get().banner).toBeNull();
  });

  it("clears the notice when the Recent view comes to the front, and one shown there when a document does", () => {
    const { store } = setup();
    store.set({ view: "recent" });
    expect(store.get().banner).toBeNull();
    const failed: BannerState = { kind: "error", message: "Downpad could not open the file." };
    store.set({ banner: failed });
    // The document behind the Recent view can change meanwhile.
    store.patchDoc({ modifiedMs: 300 });
    expect(store.get().banner).toBe(failed);
    store.set({ view: "wysiwyg" });
    expect(store.get().banner).toBeNull();
  });

  it("clears a notice on the Recent view when the last tab closes behind it", () => {
    const { store } = setup();
    store.set({ view: "recent" });
    store.set({ banner: notice });
    store.closeTab(store.get().activeTabId!);
    expect(store.get().banner).toBeNull();
  });

  it("leaves a notice that shows after the switch, as while the new document's editor is built", () => {
    const { store } = setup();
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    const later: BannerState = { kind: "error", message: "Downpad could not add “pic.png”." };
    store.set({ banner: later });
    store.patchDoc({ modifiedMs: 300 });
    expect(store.get().banner).toBe(later);
  });

  it("stops when unsubscribed", () => {
    const { store, stop } = setup();
    stop();
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    expect(store.get().banner).toBe(notice);
  });
});
