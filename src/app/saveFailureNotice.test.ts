import { describe, expect, it } from "vitest";
import { createAppStore } from "./createAppStore";
import { SaveFailureNotice } from "./saveFailureNotice";

function setup() {
  const store = createAppStore();
  return { store, notice: new SaveFailureNotice(store), tabId: store.get().activeTabId! };
}

const denied = new Error("Error invoking remote method 'command': Error: EACCES: permission denied, open '/docs/notes.md'");

describe("the notice of a failed save", () => {
  it("names the document and the reason", () => {
    const { store, notice, tabId } = setup();
    notice.show(tabId, "notes.md", denied);
    expect(store.get().banner).toEqual({ kind: "error", message: "Downpad could not save “notes.md”. Permission was denied, or another program is using the file." });
  });

  it("goes once a write of its document worked, and not for a write of another tab", () => {
    const { store, notice, tabId } = setup();
    notice.show(tabId, "notes.md", denied);
    notice.saved("another-tab");
    expect(store.get().banner?.kind).toBe("error");
    notice.saved(tabId);
    expect(store.get().banner).toBeNull();
  });

  it("stays through a read of the file, which records another file time but saves nothing", () => {
    const { store, notice, tabId } = setup();
    store.patchDoc({ filePath: "/docs/notes.md", savedMarkdown: "# Saved\n", markdown: "# Edited\n", isDirty: true, modifiedMs: 100 });
    notice.show(tabId, "notes.md", denied);
    store.patchDoc({ modifiedMs: 200, fileSize: 8 });
    expect(store.get().banner?.kind).toBe("error");
  });

  it("leaves a notice that replaced it, and forgets a notice the user dismissed", () => {
    const { store, notice, tabId } = setup();
    notice.show(tabId, "notes.md", denied);
    const other = { kind: "info" as const, message: "Spelling check complete. No misspellings found." };
    store.set({ banner: other });
    notice.saved(tabId);
    expect(store.get().banner).toBe(other);

    // A later failure of another save shows again, and its own write clears it.
    notice.show(tabId, "notes.md", denied);
    store.set({ banner: null });
    notice.saved(tabId);
    expect(store.get().banner).toBeNull();
    store.set({ banner: other });
    notice.saved(tabId);
    expect(store.get().banner).toBe(other);
  });
});
