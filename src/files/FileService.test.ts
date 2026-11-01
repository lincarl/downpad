// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { applyEditorMarkdownForTab } from "../document/DocumentModel";
import type { FileMeta, FilePayload } from "../ipc/contracts";
import { blankDoc, type Eol } from "../state/types";
import { FileService } from "./FileService";

const native = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<FilePayload>>(),
  writeFile: vi.fn<(path: string, content: string, eol: Eol) => Promise<FileMeta>>(),
  watchFile: vi.fn<(path: string) => Promise<void>>(),
  recordFileOpened: vi.fn<(path: string, openedAtMs: number) => Promise<unknown>>(),
  ask: vi.fn<(message: string) => Promise<boolean>>(),
  confirmSaveChanges: vi.fn<(message: string) => Promise<"save" | "discard" | "cancel">>(),
  saveDialog: vi.fn<(options: unknown) => Promise<string | null>>(),
}));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", () => ({
  readFile: native.readFile,
  writeFile: native.writeFile,
  watchFile: native.watchFile,
  recordFileOpened: native.recordFileOpened,
}));
vi.mock("../ipc/dialogs", () => ({ ask: native.ask, saveDialog: native.saveDialog, confirmSaveChanges: native.confirmSaveChanges }));

const filePath = "/docs/notes.md";
const onDisk: FilePayload = {
  content: "# Changed outside the app\n",
  eol: "crlf",
  hadBom: false,
  modifiedMs: 200,
  sizeBytes: 28,
};

function setup(dirty = false) {
  const store = createAppStore();
  store.addTab({
    ...blankDoc(),
    markdown: "# Original content\n",
    filePath,
    modifiedMs: 100,
    isDirty: dirty,
    savedMarkdown: dirty ? "# Saved before\n" : "# Original content\n",
    frontmatterCollapsed: true,
  });
  const presenter = {
    flush: vi.fn(),
    showActiveDoc: vi.fn(async () => {}),
    reloadActiveDoc: vi.fn(async () => {}),
  };
  return { store, presenter, files: new FileService(store, presenter) };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.readFile.mockResolvedValue(onDisk);
  native.writeFile.mockResolvedValue({ modifiedMs: 200 });
  native.watchFile.mockResolvedValue();
  native.recordFileOpened.mockResolvedValue({});
  native.ask.mockResolvedValue(true);
  native.confirmSaveChanges.mockResolvedValue("save");
  native.saveDialog.mockResolvedValue(null);
});

/** Retry an assertion every millisecond. The awaited calls happen a few
 *  microtasks later, so vi.waitFor's default 50 ms interval cost each wait a
 *  whole interval. */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { interval: 1 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

describe("saving document snapshots", () => {
  it("collects edits the editor has not reported before taking the snapshot", async () => {
    const { store, presenter, files } = setup();
    presenter.flush.mockImplementation(() => store.patchDoc({ markdown: "# Typed just now\n", isDirty: true }));

    expect(await files.save()).toBe(true);
    expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Typed just now\n", "lf");
    expect(store.get().doc).toMatchObject({ markdown: "# Typed just now\n", isDirty: false });
  });

  it("records the saved text, so an edit back to it is saved again", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;

    expect(await files.save()).toBe(true);
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Original content\n", isDirty: false });
    applyEditorMarkdownForTab(store, tabId, "# Edited\n");
    expect(store.get().doc.isDirty).toBe(true);
    applyEditorMarkdownForTab(store, tabId, "# Original content\n");
    expect(store.get().doc.isDirty).toBe(false);
  });

  it("keeps a document unsaved after its save while a file dropped on it is on its way in", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    store.setFilesPending(tabId, true);

    await files.save();

    expect(store.get().doc.isDirty).toBe(false);
    expect(files.anyDirty()).toBe(true);
    store.setFilesPending(tabId, false);
    expect(files.anyDirty()).toBe(false);
  });

  it("keeps an edit back to the old saved text unsaved while the save is written", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# Edited\n");
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const saving = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Edited\n", "lf"));
    // The file may already hold the edit, so undoing it must not read as saved.
    applyEditorMarkdownForTab(store, tabId, "# Original content\n");
    expect(store.get().doc.isDirty).toBe(true);
    expect(files.anyDirty()).toBe(true);
    write.resolve({ modifiedMs: 200 });

    expect(await saving).toBe(true);
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Edited\n", isDirty: true });
  });

  it("keeps a newer change on disk recorded while the save was written", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# Saved\n");
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const saving = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Saved\n", "lf"));
    // More typing, and another program writes that same text after this save.
    applyEditorMarkdownForTab(store, tabId, "# Typed later\n");
    store.patchDocById(tabId, { savedMarkdown: "# Typed later\n", modifiedMs: 300, isDirty: false });
    write.resolve({ modifiedMs: 200 });

    expect(await saving).toBe(true);
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Typed later\n", modifiedMs: 300, isDirty: false });
  });

  it("restores the saved text when the write fails", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# Edited\n");
    native.writeFile.mockRejectedValueOnce(new Error("Disk unavailable"));

    await expect(files.save()).rejects.toThrow("Disk unavailable");
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Original content\n", isDirty: true });
    applyEditorMarkdownForTab(store, tabId, "# Original content\n");
    expect(store.get().doc.isDirty).toBe(false);
  });

  it("keeps edits made while a save is pending dirty", async () => {
    const { store, files } = setup(true);
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const saving = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# New edits\n", isDirty: true });
    write.resolve({ modifiedMs: 200 });

    expect(await saving).toBe(true);
    expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Original content\n", "lf");
    expect(store.get().doc).toMatchObject({ markdown: "# New edits\n", isDirty: true, modifiedMs: 200 });
  });

  it("updates the initiating tab when another tab becomes active", async () => {
    const { store, files } = setup(true);
    const savedId = store.get().activeTabId;
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const saving = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    const other = { ...blankDoc(), filePath: "/docs/other.md", markdown: "# Other edits\n", isDirty: true, modifiedMs: 300 };
    store.addTab(other);
    write.resolve({ modifiedMs: 200 });

    await saving;
    expect(store.get().tabs.find((tab) => tab.id === savedId)?.doc).toMatchObject({ isDirty: false, modifiedMs: 200 });
    expect(store.get().doc).toEqual(other);
    expect(store.get().saveStatus.lastSavedAt).toBeNull();
  });

  it("orders overlapping save requests and retains each requested buffer", async () => {
    const { store, files } = setup(true);
    const first = deferred<FileMeta>();
    const second = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const initialSave = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# Later buffer\n", isDirty: true });
    const laterSave = files.save();
    expect(native.writeFile).toHaveBeenCalledOnce();
    first.resolve({ modifiedMs: 200 });
    await initialSave;
    expect(store.get().doc.isDirty).toBe(true);
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(native.writeFile).toHaveBeenNthCalledWith(2, filePath, "# Later buffer\n", "lf");
    second.resolve({ modifiedMs: 300 });

    await laterSave;
    expect(store.get().doc).toMatchObject({ markdown: "# Later buffer\n", isDirty: false, modifiedMs: 300 });
  });

  it("routes a queued Save to the path chosen by Save As and preserves later edits", async () => {
    const { store, files } = setup(true);
    store.patchDoc({ filePath: null });
    const dialog = deferred<string | null>();
    const first = deferred<FileMeta>();
    const second = deferred<FileMeta>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    native.writeFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# Edited during dialog\n", isDirty: true });
    const queuedSave = files.save();
    dialog.resolve("/docs/selected.md");
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    expect(native.writeFile).toHaveBeenNthCalledWith(1, "/docs/selected.md", "# Original content\n", "lf");
    first.resolve({ modifiedMs: 200 });
    await saveAs;
    expect(store.get().doc).toMatchObject({ filePath: "/docs/selected.md", isDirty: true, savedMarkdown: "# Original content\n" });
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(native.writeFile).toHaveBeenNthCalledWith(2, "/docs/selected.md", "# Edited during dialog\n", "lf");
    second.resolve({ modifiedMs: 300 });

    await queuedSave;
    expect(native.saveDialog).toHaveBeenCalledOnce();
    expect(store.get().doc).toMatchObject({ filePath: "/docs/selected.md", markdown: "# Edited during dialog\n", isDirty: false });
  });

  it("allows Save after a cancelled Save As without changing the document path", async () => {
    const { store, files } = setup(true);
    const before = store.get().doc;
    expect(await files.saveAs()).toBe(false);
    expect(store.get().doc).toEqual(before);
    expect(native.writeFile).not.toHaveBeenCalled();

    expect(await files.save()).toBe(true);
    expect(native.writeFile).toHaveBeenCalledExactlyOnceWith(filePath, before.markdown, before.eol);
    expect(store.get().doc.filePath).toBe(filePath);
  });

  it("does not write or patch another tab after its Save As owner closes", async () => {
    const { store, files } = setup(true);
    const owner = store.get().activeTabId!;
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const saving = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.closeTab(owner);
    const other = { ...blankDoc(), markdown: "# Other edits\n", isDirty: true };
    store.addTab(other);
    dialog.resolve("/docs/closed.md");

    expect(await saving).toBe(false);
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc).toEqual(other);
  });

  it("abandons a queued save when its tab now contains a different file", async () => {
    const { store, files } = setup(true);
    const saving = files.save();
    const replacement = { ...blankDoc(), filePath: "/docs/replacement.md", markdown: "# Replacement\n" };
    store.replaceActiveDoc(replacement);

    expect(await saving).toBe(false);
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc).toEqual(replacement);
  });

  it("tells when no save that can move a document is under way, through the Save As dialog and its write", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    // A plain Save keeps the document where it is, so nothing waits for it.
    const save = files.save();
    await files.untilPathSettled(tabId);
    await save;

    const settled = vi.fn();
    const dialog = deferred<string | null>();
    const write = deferred<FileMeta>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    void files.untilPathSettled(tabId).then(settled);
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    dialog.resolve("/moved/notes.md");
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    write.resolve({ modifiedMs: 300 });
    await eventually(() => expect(settled).toHaveBeenCalledOnce());
    expect(store.get().doc.filePath).toBe("/moved/notes.md");
    expect(await saveAs).toBe(true);
  });

  it("tells when a save of an untitled document is no longer under way, also after the user cancels it", async () => {
    const { store, files } = setup(true);
    store.patchDoc({ filePath: null });
    const tabId = store.get().activeTabId!;
    const settled = vi.fn();
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const save = files.save();
    void files.untilPathSettled(tabId).then(settled);
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    dialog.resolve(null);
    await eventually(() => expect(settled).toHaveBeenCalledOnce());
    expect(await save).toBe(false);
  });

  it("continues a queued save after the earlier write fails", async () => {
    const { store, files } = setup(true);
    const first = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(first.promise);
    const saving = files.save();
    const rejected = expect(saving).rejects.toThrow("Disk unavailable");
    store.patchDoc({ markdown: "# Retry buffer\n", isDirty: true });
    const retry = files.save();
    first.reject(new Error("Disk unavailable"));

    await rejected;
    expect(await retry).toBe(true);
    expect(native.writeFile).toHaveBeenNthCalledWith(2, filePath, "# Retry buffer\n", "lf");
    expect(store.get().doc).toMatchObject({ markdown: "# Retry buffer\n", isDirty: false });
  });
});

describe("following a document to the file its save chose", () => {
  it.each([
    { save: "the first save of an untitled document", startPath: null, run: (files: FileService) => files.save() },
    { save: "Save As", startPath: filePath, run: (files: FileService) => files.saveAs() },
  ])("watches the chosen file and records it in Recent after $save", async ({ startPath, run }) => {
    const { store, files } = setup(true);
    store.patchDoc({ filePath: startPath });
    native.saveDialog.mockResolvedValueOnce("/docs/selected.md");

    expect(await run(files)).toBe(true);
    expect(native.writeFile).toHaveBeenCalledExactlyOnceWith("/docs/selected.md", "# Original content\n", "lf");
    expect(native.watchFile).toHaveBeenCalledExactlyOnceWith("/docs/selected.md");
    expect(native.recordFileOpened).toHaveBeenCalledExactlyOnceWith("/docs/selected.md", expect.any(Number));
  });

  it("leaves the watcher and Recent alone after a plain Save", async () => {
    const { files } = setup(true);

    expect(await files.save()).toBe(true);
    expect(native.writeFile).toHaveBeenCalledOnce();
    expect(native.watchFile).not.toHaveBeenCalled();
    expect(native.recordFileOpened).not.toHaveBeenCalled();
  });

  it("leaves the watcher on the shown file when a Save As finishes after another tab became active", async () => {
    const { store, files } = setup(true);
    const owner = store.get().activeTabId!;
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const saving = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    dialog.resolve("/docs/selected.md");

    expect(await saving).toBe(true);
    expect(store.get().tabs.find((tab) => tab.id === owner)?.doc.filePath).toBe("/docs/selected.md");
    expect(native.watchFile).not.toHaveBeenCalled();
  });
});

describe("saving before close", () => {
  it("saves the inactive closing tab without changing the active document", async () => {
    const { store, files } = setup(true);
    const owner = store.get().activeTabId!;
    const other = store.addTab({ ...blankDoc(), markdown: "Other edits\n", isDirty: true });

    expect(await files.confirmCloseTab(owner, "notes.md")).toBe("close");
    expect(native.writeFile).toHaveBeenCalledExactlyOnceWith(filePath, "# Original content\n", "lf");
    expect(store.get().activeTabId).toBe(other);
    expect(store.get().doc).toMatchObject({ markdown: "Other edits\n", isDirty: true });
    expect(files.canCloseTabs([owner])).toBe(true);
    expect(files.canCloseTabs()).toBe(false);
  });

  it("saves named and untitled tabs in order and awaits the last write", async () => {
    const { store, files } = setup(true);
    const untitled = store.addTab({ ...blankDoc(), markdown: "New document\n", isDirty: true });
    const lastWrite = deferred<FileMeta>();
    native.saveDialog.mockResolvedValueOnce("/docs/new.md");
    native.writeFile.mockResolvedValueOnce({ modifiedMs: 200 }).mockReturnValueOnce(lastWrite.promise);
    const complete = vi.fn();
    const closing = files.confirmCloseAll().then((decision) => { complete(); return decision; });
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(complete).not.toHaveBeenCalled();
    expect(native.writeFile).toHaveBeenNthCalledWith(2, "/docs/new.md", "New document\n", "lf");
    lastWrite.resolve({ modifiedMs: 300 });

    expect(await closing).toBe("close");
    expect(native.confirmSaveChanges).toHaveBeenCalledExactlyOnceWith("2 documents have unsaved changes. Save before closing?");
    expect(store.get().tabs).toHaveLength(3);
    expect(store.get().activeTabId).toBe(untitled);
    expect(files.canCloseTabs()).toBe(true);
  });

  it.each(["cancel", "discard"] as const)("does not write when the close prompt returns %s", async (choice) => {
    const { store, files } = setup(true);
    native.confirmSaveChanges.mockResolvedValueOnce(choice);
    expect(await files.confirmCloseTab(store.get().activeTabId!, "notes.md")).toBe(choice);
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc.isDirty).toBe(true);
  });

  it("cancels the whole close if an untitled tab's Save As is cancelled", async () => {
    const { store, files } = setup(true);
    store.addTab({ ...blankDoc(), markdown: "Untitled edits\n", isDirty: true });
    store.addTab({ ...blankDoc(), filePath: "/docs/last.md", markdown: "Last edits\n", isDirty: true });

    expect(await files.confirmCloseAll()).toBe("cancel");
    expect(native.writeFile).toHaveBeenCalledTimes(1);
    expect(store.get().tabs).toHaveLength(4);
    expect(store.get().tabs[1]!.doc.isDirty).toBe(false);
    expect(store.get().tabs[2]!.doc.isDirty).toBe(true);
  });

  it("keeps every tab when a close save fails", async () => {
    const { store, files } = setup(true);
    native.writeFile.mockRejectedValueOnce(new Error("Disk unavailable"));

    await expect(files.confirmCloseAll()).rejects.toThrow("Disk unavailable");
    expect(store.get().tabs).toHaveLength(2);
    expect(store.get().doc).toMatchObject({ isDirty: true, savedMarkdown: "# Saved before\n" });
  });

  it("rejects later typing that only reaches the store in the final editor flush", async () => {
    const { store, presenter, files } = setup(true);
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const closing = files.confirmCloseAll();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    presenter.flush.mockImplementation(() => store.patchDoc({ markdown: "Later typing\n", isDirty: true }));
    write.resolve({ modifiedMs: 200 });

    expect(await closing).toBe("cancel");
    expect(store.get().doc).toMatchObject({ markdown: "Later typing\n", isDirty: true });
  });

  it("rechecks earlier saved tabs after waiting for the last tab", async () => {
    const { store, files } = setup(true);
    const first = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), filePath: "/docs/second.md", markdown: "Second\n", isDirty: true });
    const lastWrite = deferred<FileMeta>();
    native.writeFile.mockResolvedValueOnce({ modifiedMs: 200 }).mockReturnValueOnce(lastWrite.promise);
    const closing = files.confirmCloseAll();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    applyEditorMarkdownForTab(store, first, "Edited after save\n");
    lastWrite.resolve({ modifiedMs: 300 });

    expect(await closing).toBe("cancel");
    expect(files.canCloseTabs()).toBe(false);
  });

  it("keeps a saved tab open while dropped assets are pending", async () => {
    const { store, files } = setup(true);
    const owner = store.get().activeTabId!;
    store.setFilesPending(owner, true);

    expect(await files.confirmCloseTab(owner, "notes.md")).toBe("cancel");
    expect(store.get().doc.isDirty).toBe(false);
    expect(files.canCloseTabs([owner])).toBe(false);
  });

  it("follows an existing Save As through the save queue without reopening its dialog", async () => {
    const { store, files } = setup(true);
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const saving = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "Latest edits\n", isDirty: true });
    const closing = files.confirmCloseAll();
    await eventually(() => expect(native.confirmSaveChanges).toHaveBeenCalledOnce());
    dialog.resolve("/docs/moved.md");

    expect(await saving).toBe(true);
    expect(await closing).toBe("close");
    expect(native.writeFile).toHaveBeenNthCalledWith(2, "/docs/moved.md", "Latest edits\n", "lf");
    expect(native.saveDialog).toHaveBeenCalledOnce();
  });

  it("waits for writes queued after the close save before approving close", async () => {
    const { store, files } = setup(true);
    const firstWrite = deferred<FileMeta>();
    const lastWrite = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(lastWrite.promise);
    const complete = vi.fn();
    const closing = files.confirmCloseAll().then((decision) => { complete(); return decision; });
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "Next save\n", isDirty: true });
    const saving = files.save();
    firstWrite.resolve({ modifiedMs: 200 });
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(complete).not.toHaveBeenCalled();
    expect(files.canCloseTabs()).toBe(false);
    lastWrite.resolve({ modifiedMs: 300 });

    expect(await saving).toBe(true);
    expect(await closing).toBe("close");
    expect(store.get().doc.savedMarkdown).toBe("Next save\n");
  });
});

describe("reloading an open file", () => {
  it.each([false, true])("rereads disk into the same tab and keeps other tabs when dirty is %s", async (dirty) => {
    const { store, presenter, files } = setup(dirty);
    const tabId = store.get().activeTabId;
    const tabs = store.get().tabs.map((tab) => tab.id);

    await files.openPath(filePath, { reload: true });

    expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(store.get().activeTabId).toBe(tabId);
    expect(store.get().tabs.map((tab) => tab.id)).toEqual(tabs);
    expect(store.get().doc).toMatchObject({
      markdown: onDisk.content,
      filePath,
      eol: "crlf",
      hadBom: onDisk.hadBom,
      modifiedMs: 200,
      isDirty: false,
      savedMarkdown: onDisk.content,
      frontmatterCollapsed: true,
    });
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
    expect(native.ask).toHaveBeenCalledTimes(dirty ? 1 : 0);
  });

  it("reloads its original tab after another tab becomes active during the read", async () => {
    const { store, presenter, files } = setup();
    const owner = store.get().activeTabId!;
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    const other = { ...blankDoc(), markdown: "# Other unsaved edits\n", isDirty: true };
    const otherId = store.addTab(other);

    read.resolve(onDisk);
    await loading;

    expect(store.get().activeTabId).toBe(owner);
    expect(store.get().doc).toMatchObject({ filePath, markdown: onDisk.content, isDirty: false });
    expect(store.get().tabs.find((tab) => tab.id === otherId)?.doc).toEqual(other);
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
  });

  it.each(["/docs/unsaved.md", filePath])("keeps the surviving tab at %s when the reload owner closes during the read", async (survivingPath) => {
    const { store, presenter, files } = setup();
    const owner = store.get().activeTabId!;
    const surviving = {
      ...blankDoc(),
      filePath: survivingPath,
      markdown: "# Irreplaceable edits\n",
      savedMarkdown: "# Previously saved\n",
      isDirty: true,
      hadBom: true,
      modifiedMs: 300,
    };
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    store.closeTab(owner);
    const survivor = store.addTab(surviving);
    const before = store.get();

    read.resolve(onDisk);
    await loading;

    expect(store.get().doc).toEqual(surviving);
    expect(store.get().activeTabId).toBe(survivor);
    expect(store.get().tabs).toEqual(before.tabs);
    expect(store.get()).toBe(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
    expect(presenter.showActiveDoc).not.toHaveBeenCalled();
  });

  it("does not recreate a tab when all tabs close during the read", async () => {
    const { store, presenter, files } = setup();
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    for (const tab of store.get().tabs) store.closeTab(tab.id);
    store.set({ view: "recent" });
    const before = store.get();

    read.resolve(onDisk);
    await loading;

    expect(store.get().tabs).toEqual([]);
    expect(store.get().activeTabId).toBeNull();
    expect(store.get()).toBe(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("preserves unsaved content when the user cancels reload", async () => {
    const { store, presenter, files } = setup(true);
    native.ask.mockResolvedValueOnce(false);
    const before = store.get().doc;

    await files.openPath(filePath, { reload: true });

    expect(native.ask).toHaveBeenCalledOnce();
    expect(native.readFile).not.toHaveBeenCalled();
    expect(store.get().doc).toEqual(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("keeps the current document when reading the changed file fails", async () => {
    const { store, presenter, files } = setup();
    const before = store.get().doc;
    native.readFile.mockRejectedValueOnce(new Error("File is unavailable"));

    await expect(files.openPath(filePath, { reload: true })).rejects.toThrow("File is unavailable");

    expect(store.get().doc).toEqual(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("normal Open focuses an existing dirty tab without rereading it", async () => {
    const { store, presenter, files } = setup(true);
    const before = store.get().doc;

    await files.openPath(filePath);

    expect(store.get().doc).toEqual(before);
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.ask).not.toHaveBeenCalled();
    expect(presenter.showActiveDoc).toHaveBeenCalledOnce();
  });
});

describe("opening a file", () => {
  it("reuses an empty untitled tab, unless a file dropped on it is on its way in", async () => {
    for (const filesPending of [false, true]) {
      const store = createAppStore();
      const untitled = store.addTab(blankDoc());
      store.setFilesPending(untitled, filesPending);
      const files = new FileService(store, { flush: vi.fn(), showActiveDoc: vi.fn(async () => {}), reloadActiveDoc: vi.fn(async () => {}) });

      const count = store.get().tabs.length;

      await files.openPath(filePath);

      const { tabs, doc } = store.get();
      expect(tabs).toHaveLength(filesPending ? count + 1 : count);
      expect(doc).toMatchObject({ filePath, markdown: onDisk.content });
      if (filesPending) expect(tabs.find((tab) => tab.id === untitled)).toEqual({ id: untitled, doc: blankDoc(), filesPending: true });
    }
  });
});
