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
  store.patchDoc({ filePath, markdown: "# Mine\n", savedMarkdown: "# Mine\n", isDirty: false, modifiedMs: 100, fileSize: 7, ...doc });
  const tabId = store.get().activeTabId!;
  const files = {
    save: vi.fn<CopyFileDependencies["files"]["save"]>(async () => saved),
    untilSaved: vi.fn<CopyFileDependencies["files"]["untilSaved"]>(async () => {}),
    isSaving: vi.fn<CopyFileDependencies["files"]["isSaving"]>(() => false),
    failedMoves: vi.fn<CopyFileDependencies["files"]["failedMoves"]>(() => 0),
  };
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
    reportSaveFailure: vi.fn(),
  };
  return { store, tabId, files, desktopEvents, reportSaveFailure: vi.mocked(dependencies.reportSaveFailure), copy: () => copyActiveFile(dependencies) };
}

describe("Copy file", () => {
  it("asks to save a recovered document first, and saves and copies nothing", async () => {
    const { store, files, copy } = setup({ modifiedMs: 0, fileSize: undefined, savedMarkdown: null, isDirty: true });
    await copy();
    expect(files.untilSaved).toHaveBeenCalledOnce();
    expect(store.get().banner).toEqual({ kind: "info", message: "Save this recovered document first. Its file may have changed while Downpad was closed." });
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).not.toHaveBeenCalled();
  });

  const recovered = { modifiedMs: 0, fileSize: undefined, savedMarkdown: null, isDirty: true };
  const recorded = { modifiedMs: 100, fileSize: 7, savedMarkdown: "# Mine\n", isDirty: false };

  it("waits for a save of the tab under way, and copies a recovered document that the save recorded", async () => {
    const { store, tabId, files, copy } = setup(recovered);
    let end!: () => void;
    files.untilSaved.mockReturnValueOnce(new Promise((resolve) => { end = resolve; }));
    const copying = copy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.untilSaved).toHaveBeenCalledWith(tabId);
    expect(store.get().banner).toBeNull();
    expect(clipboard.copy).not.toHaveBeenCalled();

    // The save that the user asked for ends and records the file.
    store.patchDoc(recorded);
    end();
    await copying;
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).toHaveBeenCalledWith(filePath);
    expect(store.get().banner).toBeNull();
  });

  it("waits again for a save that starts while a comparison of the file runs", async () => {
    const { store, files, desktopEvents, copy } = setup(recovered);
    // The user saves the recovered document while Copy file waits for the
    // comparison, and the second wait ends once that save recorded the file.
    desktopEvents.settled.mockImplementationOnce(async () => { files.isSaving.mockReturnValueOnce(true); });
    files.untilSaved.mockResolvedValueOnce().mockImplementationOnce(async () => {
      store.patchDoc(recorded);
    });
    await copy();
    expect(files.untilSaved).toHaveBeenCalledTimes(2);
    expect(clipboard.copy).toHaveBeenCalledWith(filePath);
    expect(store.get().banner).toBeNull();
  });

  it.each([
    { wait: "a save", during: "untilSaved" },
    { wait: "a comparison of the file", during: "settled" },
  ] as const)("saves and copies nothing after a Save As that failed or was cancelled while it waited for $wait", async ({ during }) => {
    const { store, files, desktopEvents, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    const failMove = async () => { files.failedMoves.mockReturnValue(1); };
    if (during === "untilSaved") files.untilSaved.mockImplementationOnce(failMove);
    else desktopEvents.settled.mockImplementationOnce(failMove);
    await copy();
    // Copy file went through both waits before it stopped.
    expect(files.untilSaved).toHaveBeenCalledOnce();
    expect(desktopEvents.settled).toHaveBeenCalledOnce();
    expect(files.save).not.toHaveBeenCalled();
    expect(clipboard.copy).not.toHaveBeenCalled();
    expect(store.get().banner).toBeNull();
  });

  it("goes on after a Save As that failed before Copy file was chosen", async () => {
    const { files, copy } = setup({});
    files.failedMoves.mockReturnValue(3);
    await copy();
    expect(clipboard.copy).toHaveBeenCalledWith(filePath);
  });

  it("leaves the clipboard to a Copy file chosen later, as for another tab while its save ran", async () => {
    const { store, files, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    let saved!: (value: boolean) => void;
    files.save.mockReturnValueOnce(new Promise((resolve) => { saved = resolve; }));
    const first = copy();
    await vi.waitFor(() => expect(files.save).toHaveBeenCalledOnce(), { interval: 1 });
    // The user copies another tab's saved file while the first save runs.
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md", savedMarkdown: "", modifiedMs: 100, fileSize: 0 });
    await copy();
    expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("/docs/other.md");
    saved(true);
    await first;
    expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("/docs/other.md");
  });

  it("leaves the clipboard to a Copy file chosen later that is still at it, or that failed there and said so", async () => {
    const { store, files, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    let saved!: (value: boolean) => void;
    files.save.mockReturnValueOnce(new Promise((resolve) => { saved = resolve; }));
    const first = copy();
    await vi.waitFor(() => expect(files.save).toHaveBeenCalledOnce(), { interval: 1 });
    // The later copy's look at its file is slow, as on a network drive.
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md", savedMarkdown: "", modifiedMs: 100, fileSize: 0 });
    let fail!: (error: Error) => void;
    clipboard.copy.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const later = copy();
    await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("/docs/other.md"), { interval: 1 });
    // The earlier one does not wait for it, and copies nothing.
    saved(true);
    await first;
    expect(clipboard.copy).toHaveBeenCalledOnce();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fail(new Error("Only a file can be copied."));
    await later;
    logged.mockRestore();
    expect(clipboard.copy).toHaveBeenCalledOnce();
    expect(store.get().banner).toEqual({ kind: "error", message: "Could not copy the file. Please try again." });
  });

  it("still copies its file when a Copy file chosen later copied nothing", async () => {
    const { store, files, desktopEvents, copy } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    let saved!: (value: boolean) => void;
    files.save.mockReturnValueOnce(new Promise((resolve) => { saved = resolve; }));
    const first = copy();
    await vi.waitFor(() => expect(files.save).toHaveBeenCalledOnce(), { interval: 1 });
    // The later one only shows the notice for a change on disk.
    desktopEvents.showPendingChange.mockReturnValueOnce(true);
    await copy();
    expect(clipboard.copy).not.toHaveBeenCalled();
    saved(true);
    await first;
    expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(store.get().banner).toBeNull();
  });

  it.each([
    { document: "a document with a recorded file size whose saved text is unknown", doc: { modifiedMs: 100, savedMarkdown: null, isDirty: true } },
    { document: "a document whose file says it was written in 1970", doc: { modifiedMs: 0, isDirty: true } },
    { document: "a document dated 1970 with a recorded file size whose saved text is unknown", doc: { modifiedMs: 0, savedMarkdown: null, isDirty: true } },
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

  it("reports a save that threw as a failed save of its document, also with another tab in front by then, and copies nothing", async () => {
    const { store, tabId, files, copy, reportSaveFailure } = setup({ markdown: "# Mine, edited\n", isDirty: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("“other.md” is open in another tab. Close that tab, or choose another name.");
    files.save.mockImplementationOnce(async () => {
      store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
      throw failure;
    });
    await copy();
    logged.mockRestore();
    expect(reportSaveFailure).toHaveBeenCalledExactlyOnceWith(tabId, failure);
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
