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
  ask: vi.fn<(message: string) => Promise<boolean>>(),
  saveDialog: vi.fn<(options: unknown) => Promise<string | null>>(),
}));

vi.mock("../ipc/commands", () => ({ readFile: native.readFile, writeFile: native.writeFile }));
vi.mock("../ipc/dialogs", () => ({ ask: native.ask, saveDialog: native.saveDialog }));

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
  native.ask.mockResolvedValue(true);
  native.saveDialog.mockResolvedValue(null);
});

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
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Edited\n", "lf"));
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
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledWith(filePath, "# Saved\n", "lf"));
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
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# Later buffer\n", isDirty: true });
    const laterSave = files.save();
    expect(native.writeFile).toHaveBeenCalledOnce();
    first.resolve({ modifiedMs: 200 });
    await initialSave;
    expect(store.get().doc.isDirty).toBe(true);
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
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
    await vi.waitFor(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# Edited during dialog\n", isDirty: true });
    const queuedSave = files.save();
    dialog.resolve("/docs/selected.md");
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledOnce());
    expect(native.writeFile).toHaveBeenNthCalledWith(1, "/docs/selected.md", "# Original content\n", "lf");
    first.resolve({ modifiedMs: 200 });
    await saveAs;
    expect(store.get().doc).toMatchObject({ filePath: "/docs/selected.md", isDirty: true, savedMarkdown: "# Original content\n" });
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
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
    await vi.waitFor(() => expect(native.saveDialog).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    dialog.resolve("/moved/notes.md");
    await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    write.resolve({ modifiedMs: 300 });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    dialog.resolve(null);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
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

describe("reloading an open file", () => {
  it("rereads disk into the same tab and keeps other tabs", async () => {
    const { store, presenter, files } = setup();
    const tabId = store.get().activeTabId;
    const tabs = store.get().tabs.map((tab) => tab.id);

    await files.openPath(filePath, { reload: true });

    expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(store.get().activeTabId).toBe(tabId);
    expect(store.get().tabs.map((tab) => tab.id)).toEqual(tabs);
    expect(store.get().doc).toMatchObject({
      markdown: onDisk.content,
      eol: "crlf",
      modifiedMs: 200,
      isDirty: false,
      savedMarkdown: onDisk.content,
      frontmatterCollapsed: true,
    });
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
    expect(native.ask).not.toHaveBeenCalled();
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
