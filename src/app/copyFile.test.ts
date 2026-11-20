import { beforeEach, describe, expect, it, vi } from "vitest";
import { blankDoc, type DocumentState } from "../state/types";
import { copyActiveFile, type CopyFileDependencies } from "./copyFile";
import { createAppStore } from "./createAppStore";

const clipboard = vi.hoisted(() => ({ copy: vi.fn<(path: string) => Promise<void>>() }));
vi.mock("../ipc/commands", () => ({ copyFileToClipboard: clipboard.copy }));

const filePath = "/docs/notes.md";

beforeEach(() => {
  clipboard.copy.mockReset();
  clipboard.copy.mockResolvedValue();
});

/** Copy file's dependencies for an active document like `doc`, with a save
 *  that ends with `saved` and a file that has no unresolved change on disk. */
function setup(doc: Partial<DocumentState>, saved = true) {
  const store = createAppStore();
  store.patchDoc({ filePath, markdown: "# Mine\n", savedMarkdown: "# Mine\n", isDirty: false, modifiedMs: 100, ...doc });
  const tabId = store.get().activeTabId!;
  const files = { save: vi.fn<CopyFileDependencies["files"]["save"]>(async () => saved) };
  const desktopEvents = {
    settled: vi.fn(async () => {}),
    showPendingChange: vi.fn(() => false),
    holdSaveAfterChecks: vi.fn(async () => false),
    recheck: vi.fn(async () => {}),
  };
  const dependencies: CopyFileDependencies = {
    store,
    files,
    editorHost: { flush: () => {} },
    desktopEvents,
    canCopyFile: () => true,
    isDisposed: () => false,
  };
  return { store, tabId, files, desktopEvents, copy: () => copyActiveFile(dependencies) };
}

describe("Copy file", () => {
  it("asks to save a recovered document first, and saves and copies nothing", async () => {
    const { store, files, copy } = setup({ modifiedMs: 0, savedMarkdown: null, isDirty: true });
    await copy();
    expect(store.get().banner).toEqual({ kind: "info", message: "Save this recovered document first. Its file may have changed while Downpad was closed." });
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).not.toHaveBeenCalled();
  });

  it.each([
    { document: "a document whose save is being written", doc: { modifiedMs: 100, savedMarkdown: null, isDirty: true } },
    { document: "a document whose file says it was written in 1970", doc: { modifiedMs: 0, isDirty: true } },
  ])("saves $document through the guarded save, and copies its file", async ({ doc }) => {
    const { store, files, desktopEvents, copy } = setup(doc);
    await copy();
    expect(files.save).toHaveBeenCalledOnce();
    const automatic = files.save.mock.calls[0][0]?.automatic;
    expect(automatic).toBeTypeOf("function");
    await automatic!("tab");
    expect(desktopEvents.holdSaveAfterChecks).toHaveBeenCalledWith("tab");
    expect(clipboard.copy).toHaveBeenCalledWith(filePath);
    expect(store.get().banner).toBeNull();
  });

  it("copies a saved document's file without saving it", async () => {
    const { files, copy } = setup({});
    await copy();
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).toHaveBeenCalledWith(filePath);
  });

  it("reads the file again after a refused save, and says it could not save only when no change on disk shows", async () => {
    const { store, desktopEvents, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true }, false);
    await copy();
    expect(desktopEvents.recheck).toHaveBeenCalledOnce();
    expect(store.get().banner).toEqual({ kind: "error", message: "Could not save the file before copying it. Please try again." });

    store.set({ banner: null });
    desktopEvents.showPendingChange.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await copy();
    expect(desktopEvents.recheck).toHaveBeenCalledTimes(2);
    expect(store.get().banner).toBeNull();
    expect(clipboard.copy).not.toHaveBeenCalled();
  });

  it("leaves a refused save alone once another tab is in front", async () => {
    const { store, files, desktopEvents, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    files.save.mockImplementationOnce(async () => {
      // The user opens another document while the save waits, and the save
      // is refused.
      store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
      return false;
    });
    await copy();
    expect(desktopEvents.recheck).not.toHaveBeenCalled();
    expect(store.get().banner).toBeNull();
    expect(clipboard.copy).not.toHaveBeenCalled();
  });

  it("copies nothing when another tab comes to the front while a comparison of the file runs", async () => {
    const { store, files, desktopEvents, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    desktopEvents.settled.mockImplementationOnce(async () => {
      store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    });
    await copy();
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).not.toHaveBeenCalled();
  });
});
