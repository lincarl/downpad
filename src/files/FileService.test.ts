// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { applyEditorMarkdownForTab } from "../document/DocumentModel";
import { FILE_CHANGED_ON_DISK, type FileMeta, type FilePayload } from "../ipc/contracts";
import { blankDoc, type Eol } from "../state/types";
import { FileService, SLOW_WRITE_MS, type SaveEvents } from "./FileService";

const native = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<FilePayload>>(),
  writeFile: vi.fn<(path: string, content: string, eol: Eol, expectedContent?: string) => Promise<FileMeta>>(),
  watchFile: vi.fn<(path: string) => Promise<void>>(),
  recordFileOpened: vi.fn<(path: string, openedAtMs: number) => Promise<unknown>>(),
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
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
  pathExists: native.pathExists,
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

function setup(dirty = false, events?: SaveEvents) {
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
  return { store, presenter, files: new FileService(store, presenter, events) };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.readFile.mockResolvedValue(onDisk);
  native.writeFile.mockResolvedValue({ modifiedMs: 200 });
  native.watchFile.mockResolvedValue();
  native.recordFileOpened.mockResolvedValue({});
  native.ask.mockResolvedValue(true);
  native.pathExists.mockResolvedValue(false);
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

describe("replacing a document with its file after a discard", () => {
  it("replaces unsaved changes that are the kept text, and shows the file", async () => {
    const { store, presenter, files } = setup(true);
    const tabId = store.get().activeTabId!;
    expect(await files.replaceFromDisk(tabId, filePath, (markdown) => markdown === "# Original content\n")).toBe("shown");
    expect(store.get().doc).toMatchObject({ markdown: onDisk.content, isDirty: false, frontmatterCollapsed: true });
    expect(presenter.reloadActiveDoc).toHaveBeenCalledTimes(1);
  });

  it("keeps text typed after the copy, which the editor reports only in its flush", async () => {
    const { store, presenter, files } = setup(true);
    const tabId = store.get().activeTabId!;
    presenter.flush.mockImplementation(() => store.patchDoc({ markdown: "# Original content\n\nTyped\n" }));
    expect(await files.replaceFromDisk(tabId, filePath, (markdown) => markdown === "# Original content\n")).toBe("changed");
    expect(store.get().doc.markdown).toBe("# Original content\n\nTyped\n");
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("replaces the document of a tab whose path Windows spells in another case", async () => {
    const { store, presenter, files } = setup();
    const tabId = store.get().activeTabId!;
    store.patchDoc({ filePath: "C:\\Docs\\Notes.md" });
    expect(await files.replaceFromDisk(tabId, "c:\\docs\\notes.md", () => true)).toBe("shown");
    expect(store.get().doc.markdown).toBe(onDisk.content);
    // The document keeps its place, and shows unless the replacement is a quiet one.
    expect(presenter.reloadActiveDoc).toHaveBeenCalledExactlyOnceWith({ keepPlace: true, quiet: false });
    expect(await files.replaceFromDisk(tabId, "c:\\docs\\notes.md", () => true, { quiet: true })).toBe("shown");
    expect(presenter.reloadActiveDoc).toHaveBeenLastCalledWith({ keepPlace: true, quiet: true });
  });

  it("leaves a tab that holds another file by now", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    store.patchDoc({ filePath: "/docs/renamed.md" });
    expect(await files.replaceFromDisk(tabId, filePath, () => true)).toBe("gone");
    expect(store.get().doc).toMatchObject({ filePath: "/docs/renamed.md", markdown: "# Original content\n" });
    expect(native.readFile).not.toHaveBeenCalled();
  });
});

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

  it("skips a queued save whose check holds it when its write would start, and tells its own write", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# First\n");
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const first = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    // The file holds the old saved text or the new one while the write runs.
    expect(files.isOwnWrite(tabId, "# First\n")).toBe(true);
    expect(files.isOwnWrite(tabId, "# Original content\n")).toBe(true);
    expect(files.isOwnWrite(tabId, "# Theirs\n")).toBe(false);

    // An autosave waits behind it, and a change on disk shows meanwhile.
    applyEditorMarkdownForTab(store, tabId, "# Second\n");
    let held = false;
    const autosave = files.save({ keepTypedMark: true, automatic: () => held });
    held = true;
    write.resolve({ modifiedMs: 200 });
    expect(await first).toBe(true);
    expect(await autosave).toBe(false);
    expect(native.writeFile).toHaveBeenCalledOnce();
    expect(files.isOwnWrite(tabId, "# First\n")).toBe(false);
  });

  it("writes an automatic save's document as it is then, only over the version it recorded", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# Typed\n");
    expect(await files.save({ automatic: () => false })).toBe(true);
    expect(native.writeFile).toHaveBeenLastCalledWith(filePath, "# Typed\n", "lf", "# Original content\n");

    // Nothing is unsaved, as after a reload, so it writes nothing.
    expect(await files.save({ automatic: () => false })).toBe(true);
    expect(native.writeFile).toHaveBeenCalledOnce();

    // The main process refuses a file that another program changed.
    applyEditorMarkdownForTab(store, tabId, "# More\n");
    native.writeFile.mockRejectedValueOnce(new Error(`Error invoking remote method: Error: ${FILE_CHANGED_ON_DISK}`));
    expect(await files.save({ automatic: () => false })).toBe(false);
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Typed\n", isDirty: true, modifiedMs: 200 });
  });

  it("asks an automatic save's check first, waits for it, and leaves a recovered document alone", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    // Held, also for a document that has nothing unsaved by now.
    expect(await files.save({ automatic: () => true })).toBe(false);
    applyEditorMarkdownForTab(store, tabId, "# Typed\n");
    let answer!: (held: boolean) => void;
    const waiting = files.save({ automatic: () => new Promise<boolean>((resolve) => (answer = resolve)) });
    await eventually(() => expect(answer).toBeDefined());
    expect(native.writeFile).not.toHaveBeenCalled();
    answer(false);
    expect(await waiting).toBe(true);
    expect(native.writeFile).toHaveBeenCalledOnce();

    // A recovered document's saved text is unknown.
    applyEditorMarkdownForTab(store, tabId, "# Recovered\n");
    store.patchDocById(tabId, { savedMarkdown: null, isDirty: true });
    expect(await files.save({ automatic: () => false })).toBe(false);
    expect(native.writeFile).toHaveBeenCalledOnce();
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

  it("tells when no save of a tab is under way, also one queued during the wait", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    await files.untilSaved(tabId);
    expect(files.isSaving(tabId)).toBe(false);

    const writes = [deferred<FileMeta>(), deferred<FileMeta>(), deferred<FileMeta>()];
    for (const write of writes) native.writeFile.mockReturnValueOnce(write.promise);
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md", markdown: "# Other\n", isDirty: true });
    const other = files.save();
    store.activateTab(tabId);
    const save = files.save();
    const saved = vi.fn();
    void files.untilSaved(tabId).then(saved);
    // The user types and saves again while the first save waits.
    store.patchDoc({ markdown: "# Later\n", isDirty: true });
    const later = files.save();
    writes[0].resolve({ modifiedMs: 300 });
    expect(await other).toBe(true);
    writes[1].resolve({ modifiedMs: 400 });
    expect(await save).toBe(true);
    await eventually(() => expect(native.writeFile).toHaveBeenCalledTimes(3));
    expect(saved).not.toHaveBeenCalled();
    expect(files.isSaving(tabId)).toBe(true);
    writes[2].resolve({ modifiedMs: 500 });
    await eventually(() => expect(saved).toHaveBeenCalledOnce());
    expect(await later).toBe(true);
    expect(files.isSaving(tabId)).toBe(false);
  });

  it("saves, saves as and closes another tab's document while a write of one does not return", async () => {
    const { store, files } = setup(true);
    const stuckTab = store.get().activeTabId!;
    // A write to a network drive that went away never answers.
    native.writeFile.mockImplementation((path) => path === filePath ? new Promise(() => {}) : Promise.resolve({ modifiedMs: 300 }));
    const stuck = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    const other = store.addTab({ ...blankDoc(), filePath: "/local/other.md", markdown: "# Other\n", isDirty: true });

    expect(await files.save()).toBe(true);
    store.patchDoc({ markdown: "# Other, moved\n", isDirty: true });
    native.saveDialog.mockResolvedValueOnce("/local/moved.md");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc).toMatchObject({ filePath: "/local/moved.md", isDirty: false });
    await files.untilSaved(other);
    await files.untilPathSettled(other);
    expect(await files.confirmCloseTab(other, "moved.md")).toBe("close");

    // Saves of the document whose write hangs wait for it.
    expect(files.isSaving(stuckTab)).toBe(true);
    store.activateTab(stuckTab);
    store.patchDoc({ markdown: "# Later\n", isDirty: true });
    const waiting = vi.fn();
    void files.save().then(waiting);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waiting).not.toHaveBeenCalled();
    expect(native.writeFile).toHaveBeenCalledTimes(3);
    void stuck;
  });

  it("shows one Save As dialog at a time, and refuses a file that another tab's Save As is still writing", async () => {
    const { store, files } = setup(true);
    const first = store.get().activeTabId!;
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise).mockResolvedValueOnce("/docs/target.md");
    native.writeFile.mockReturnValueOnce(new Promise(() => {}));
    const firstSave = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    store.addTab({ ...blankDoc(), filePath: "/docs/second.md", markdown: "# Second\n", isDirty: true });
    const secondSave = files.saveAs();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.saveDialog).toHaveBeenCalledOnce();

    dialog.resolve("/docs/target.md");
    await expect(secondSave).rejects.toThrow("“target.md” is being saved from another tab. Choose another name.");
    expect(native.writeFile).toHaveBeenCalledExactlyOnceWith("/docs/target.md", "# Original content\n", "lf");
    expect(files.isSaving(first)).toBe(true);
    void firstSave;
  });

  it("lets another tab's Save As show its dialog while a look for a file does not answer, and lets one tab claim the name", async () => {
    const { store, files } = setup();
    const first = store.get().activeTabId!;
    store.patchDoc({ filePath: "/share/settings.json" });
    // The share stops answering the look for a file of the full name.
    const look = deferred<boolean>();
    native.pathExists.mockReturnValueOnce(look.promise);
    native.saveDialog.mockResolvedValueOnce("/share/backup").mockResolvedValueOnce("/share/backup.json");
    native.writeFile.mockReturnValueOnce(new Promise(() => {}));
    const firstSave = files.saveAs();
    await eventually(() => expect(native.pathExists).toHaveBeenCalledOnce());
    store.addTab({ ...blankDoc(), filePath: "/docs/other.json", markdown: "{}\n", isDirty: true });
    void files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledExactlyOnceWith("/share/backup.json", "{}\n", "lf"));
    // The first Save As finds the name claimed once its look answers.
    look.resolve(false);
    await expect(firstSave).rejects.toThrow("“backup.json” is being saved from another tab. Choose another name.");
    expect(files.isSaving(first)).toBe(false);
  });

  it("tells about a write that has run for a while without an answer, and once it ends", async () => {
    vi.useFakeTimers();
    try {
      const events = { slowWrite: vi.fn<(tabId: string) => void>(), slowWriteEnded: vi.fn<(tabId: string) => void>() };
      const { store, files } = setup(true, events);
      const tabId = store.get().activeTabId!;
      // A write that answers in time says nothing.
      expect(await files.save()).toBe(true);
      const write = deferred<FileMeta>();
      native.writeFile.mockReturnValueOnce(write.promise);
      store.patchDoc({ markdown: "# Slow\n", isDirty: true });
      const saving = files.save();
      await vi.advanceTimersByTimeAsync(SLOW_WRITE_MS - 1);
      expect(events.slowWrite).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(events.slowWrite).toHaveBeenCalledExactlyOnceWith(tabId);

      // Another save asked for meanwhile waits for it, so it tells again.
      const later = files.save();
      expect(events.slowWrite).toHaveBeenCalledTimes(2);
      expect(events.slowWriteEnded).not.toHaveBeenCalled();
      write.resolve({ modifiedMs: 300 });
      expect(await saving).toBe(true);
      expect(events.slowWriteEnded).toHaveBeenCalledExactlyOnceWith(tabId);
      expect(await later).toBe(true);
      expect(events.slowWrite).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for a later save of another tab", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    const slow = deferred<FileMeta>();
    native.writeFile.mockResolvedValueOnce({ modifiedMs: 300 }).mockReturnValueOnce(slow.promise);
    const save = files.save();
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md", markdown: "# Other\n", isDirty: true });
    const other = files.save();
    await files.untilSaved(tabId);
    expect(await save).toBe(true);
    slow.resolve({ modifiedMs: 400 });
    expect(await other).toBe(true);
  });

  it("suggests the document's own kind first in the save dialog, whose extension the dialog adds to a bare name", async () => {
    const { store, files } = setup();
    const offered = (): string[] => (native.saveDialog.mock.lastCall![0] as { filters: Array<{ name: string }> }).filters.map((filter) => filter.name);

    await files.saveAs();
    expect(offered()).toEqual(["Markdown", "Text", "JSON", "YAML", "All files"]);

    store.patchDoc({ filePath: "/docs/settings.json" });
    await files.saveAs();
    expect(offered()).toEqual(["JSON", "Markdown", "Text", "YAML", "All files"]);

    // The file's own extension comes first, which a Windows dialog adds to a bare name.
    store.patchDoc({ filePath: "/docs/compose.yml" });
    await files.saveAs();
    expect((native.saveDialog.mock.lastCall![0] as { filters: unknown[] }).filters[0]).toEqual({ name: "YAML", extensions: ["yml", "yaml"] });

    // An untitled document is Markdown.
    store.patchDoc({ filePath: null });
    await files.save();
    expect(offered()[0]).toBe("Markdown");
  });

  it("gives a name chosen without an extension the extension of a JSON or YAML file, so the file keeps its kind", async () => {
    const { store, files } = setup();
    store.patchDoc({ filePath: "/docs/settings.json" });
    native.saveDialog.mockResolvedValueOnce("/docs/backup");
    expect(await files.saveAs()).toBe(true);
    expect(native.writeFile).toHaveBeenLastCalledWith("/docs/backup.json", "# Original content\n", "lf");
    expect(store.get().doc.filePath).toBe("/docs/backup.json");
    expect(native.ask).not.toHaveBeenCalled();

    // A YAML file keeps the extension it has, and a dot typed last is not doubled.
    store.patchDoc({ filePath: "/docs/compose.yml" });
    native.saveDialog.mockResolvedValueOnce("C:\\docs\\copy.");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("C:\\docs\\copy.yml");

    // A name with an extension is the user's choice of kind, and a Markdown
    // document keeps a bare name, which reads as Markdown anyway.
    native.saveDialog.mockResolvedValueOnce("/docs/notes.md");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("/docs/notes.md");
    native.saveDialog.mockResolvedValueOnce("/docs/README");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("/docs/README");
    expect(native.pathExists).toHaveBeenCalledTimes(2);

    // A dot that starts the name is part of the name, not an extension.
    store.patchDoc({ filePath: "/docs/formatter.json" });
    native.saveDialog.mockResolvedValueOnce("/docs/.prettierrc");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("/docs/.prettierrc.json");
  });

  it("fails the save when it cannot tell whether a file of the full name exists, so it never replaces one unasked", async () => {
    const { store, files } = setup();
    store.patchDoc({ filePath: "/docs/settings.json" });
    // The share stops answering for the look.
    native.pathExists.mockRejectedValueOnce(new Error("Error invoking remote method 'downpad:invoke': Error: EIO: i/o error, stat '/share/backup.json'"));
    native.saveDialog.mockResolvedValueOnce("/share/backup");
    await expect(files.saveAs()).rejects.toThrow("EIO");
    expect(native.ask).not.toHaveBeenCalled();
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc.filePath).toBe("/docs/settings.json");
  });

  it("asks before the name with the added extension replaces a file, which the dialog did not ask about", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    store.patchDoc({ filePath: "/docs/settings.json" });
    native.pathExists.mockResolvedValue(true);

    native.ask.mockResolvedValueOnce(false);
    native.saveDialog.mockResolvedValueOnce("/docs/backup");
    expect(await files.saveAs()).toBe(false);
    expect(native.ask).toHaveBeenCalledExactlyOnceWith("“backup.json” already exists. Replace it?", expect.objectContaining({ okLabel: "Replace" }));
    expect(native.pathExists).toHaveBeenCalledExactlyOnceWith("/docs/backup.json");
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc.filePath).toBe("/docs/settings.json");
    // A Save As the user backed out of, as one cancelled in its dialog.
    expect(files.failedMoves(tabId)).toBe(1);

    native.ask.mockResolvedValueOnce(true);
    native.saveDialog.mockResolvedValueOnce("/docs/backup");
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("/docs/backup.json");
  });

  it("refuses a name whose added extension makes it a file open in another tab", async () => {
    const { store, files } = setup();
    store.patchDoc({ filePath: "/docs/settings.json" });
    store.addTab({ ...store.get().doc, filePath: "/docs/other.json" });
    native.saveDialog.mockResolvedValueOnce("/docs/settings");
    await expect(files.saveAs()).rejects.toThrow("“settings.json” is open in another tab");
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("counts a Save As that fails or is cancelled and a cancelled save of an untitled document, but not a plain save that fails", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    expect(files.failedMoves(tabId)).toBe(0);
    native.saveDialog.mockResolvedValueOnce("/moved/notes.md");
    native.writeFile.mockRejectedValueOnce(new Error("Disk unavailable"));
    const saveAs = files.saveAs();
    const waited = files.untilSaved(tabId).then(() => files.failedMoves(tabId));
    await expect(saveAs).rejects.toThrow("Disk unavailable");
    // The count is there as soon as no save of the tab is under way.
    expect(files.isSaving(tabId)).toBe(false);
    expect(files.failedMoves(tabId)).toBe(1);
    expect(await waited).toBe(1);
    expect(store.get().doc.filePath).toBe(filePath);

    native.saveDialog.mockResolvedValueOnce(null);
    expect(await files.saveAs()).toBe(false);
    expect(files.failedMoves(tabId)).toBe(2);

    native.writeFile.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(files.save()).rejects.toThrow("Disk unavailable");
    expect(files.failedMoves(tabId)).toBe(2);

    store.patchDoc({ filePath: null });
    native.saveDialog.mockResolvedValueOnce(null);
    expect(await files.save()).toBe(false);
    expect(files.failedMoves(tabId)).toBe(3);

    // A save queued behind the first save of an untitled document has its
    // path once that one ends, so its failed write moves nothing.
    native.saveDialog.mockResolvedValueOnce("/docs/named.md");
    native.writeFile.mockResolvedValueOnce({ modifiedMs: 300 }).mockRejectedValueOnce(new Error("Disk unavailable"));
    const first = files.save();
    store.patchDoc({ markdown: "# Later\n", isDirty: true });
    const second = files.save();
    expect(await first).toBe(true);
    await expect(second).rejects.toThrow("Disk unavailable");
    expect(files.failedMoves(tabId)).toBe(3);

    // The count of a closed tab goes when the next one is counted.
    store.addTab(blankDoc());
    const untitled = store.get().activeTabId!;
    store.closeTab(tabId);
    native.saveDialog.mockResolvedValueOnce(null);
    expect(await files.save()).toBe(false);
    expect(files.failedMoves(untitled)).toBe(1);
    expect(files.failedMoves(tabId)).toBe(0);
  });

  it("tells each write of a tab's document that worked, and no save that wrote nothing", async () => {
    const onSaved = vi.fn<(tabId: string) => void>();
    const { store, files } = setup(true, { saved: onSaved });
    const tabId = store.get().activeTabId!;
    native.writeFile.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(files.save()).rejects.toThrow("Disk unavailable");
    native.saveDialog.mockResolvedValueOnce(null);
    expect(await files.saveAs()).toBe(false);
    expect(await files.save({ automatic: () => true })).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();

    // A save the user asks for, and one nobody asked for.
    expect(await files.save()).toBe(true);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(tabId);
    store.patchDoc({ markdown: "# Later\n", isDirty: true });
    expect(await files.save({ automatic: () => false })).toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("opens a file in a tab of its own while the untitled tab in front is being saved, also once the user emptied it", async () => {
    const { store, files } = setup();
    store.addTab({ ...blankDoc(), markdown: "Draft\n", isDirty: true });
    const untitled = store.get().activeTabId!;
    const write = deferred<FileMeta>();
    native.saveDialog.mockResolvedValueOnce("/docs/draft.md");
    native.writeFile.mockReturnValueOnce(write.promise);
    const saving = files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    // The user takes the text back while the file is written, and opens another file.
    store.patchDoc({ markdown: "", isDirty: false });
    const tabs = store.get().tabs.length;
    await files.openPath("/docs/other.md");
    expect(store.get().tabs).toHaveLength(tabs + 1);
    expect(store.get().doc.filePath).toBe("/docs/other.md");
    write.resolve({ modifiedMs: 300 });
    expect(await saving).toBe(true);
    expect(store.get().tabs.find((tab) => tab.id === untitled)?.doc.filePath).toBe("/docs/draft.md");

    // Without a save under way, an empty untitled tab takes the file opened.
    store.addTab(blankDoc());
    const count = store.get().tabs.length;
    await files.openPath("/docs/third.md");
    expect(store.get().tabs).toHaveLength(count);
    expect(store.get().doc.filePath).toBe("/docs/third.md");
  });

  it("takes a Save As onto the document's file for a write of that file, also when Windows spells the path in another case", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    store.patchDoc({ filePath: "C:\\Docs\\notes.md" });
    const write = deferred<FileMeta>();
    native.saveDialog.mockResolvedValueOnce("c:\\docs\\NOTES.md");
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    // The file may hold the old text or the new one until the write ends.
    expect(store.get().doc.savedMarkdown).toBeNull();
    // Another program writes the file after this save, and the app records
    // that version, which the save's answer must not replace.
    store.patchDocById(tabId, { savedMarkdown: "# Theirs\n", modifiedMs: 900, isDirty: true });
    // A Save queued meanwhile still writes, to the path the document keeps.
    const queued = files.save();
    write.resolve({ modifiedMs: 300 });
    expect(await saveAs).toBe(true);
    expect(store.get().doc).toMatchObject({ filePath: "C:\\Docs\\notes.md", savedMarkdown: "# Theirs\n", modifiedMs: 900, isDirty: true });
    expect(await queued).toBe(true);
    expect(native.writeFile).toHaveBeenCalledTimes(2);
    expect(native.writeFile.mock.calls[1][0]).toBe("C:\\Docs\\notes.md");
  });

  it("refuses a Save As, and the first save of an untitled document, onto a file that is open in another tab", async () => {
    const { store, files } = setup(true);
    const first = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), filePath: "C:\\Docs\\Other.md", markdown: "# Other\n", savedMarkdown: "# Other\n" });
    store.activateTab(first);
    native.saveDialog.mockResolvedValueOnce("c:\\docs\\other.md");
    await expect(files.saveAs()).rejects.toThrow("“other.md” is open in another tab. Close that tab, or choose another name.");
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc.filePath).toBe(filePath);
    expect(files.failedMoves(first)).toBe(1);

    store.addTab({ ...blankDoc(), markdown: "Draft\n", isDirty: true });
    native.saveDialog.mockResolvedValueOnce(filePath);
    await expect(files.save()).rejects.toThrow("“notes.md” is open in another tab.");
    expect(native.writeFile).not.toHaveBeenCalled();

    // Onto its own file, a Save As writes.
    store.activateTab(first);
    native.saveDialog.mockResolvedValueOnce(filePath);
    expect(await files.saveAs()).toBe(true);
    expect(native.writeFile).toHaveBeenCalledOnce();
  });

  it("takes for its own write only a save that is writing the document's file", async () => {
    const { store, files } = setup(true);
    const tabId = store.get().activeTabId!;
    const { markdown: text, savedMarkdown: saved } = store.get().doc;
    expect(saved).not.toBeNull();
    // A Save As waits for its dialog, and then writes another file.
    const dialog = deferred<string | null>();
    const write = deferred<FileMeta>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    expect(files.isOwnWrite(tabId, text)).toBe(false);
    dialog.resolve("/moved/notes.md");
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    expect(files.isOwnWrite(tabId, text)).toBe(false);
    // The document's own file is not written, so its saved text stays known
    // and a report of that file still compares with it.
    expect(store.get().doc.savedMarkdown).toBe(saved);
    write.resolve({ modifiedMs: 300 });
    expect(await saveAs).toBe(true);
    expect(store.get().doc).toMatchObject({ filePath: "/moved/notes.md", savedMarkdown: text, isDirty: false });
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
    // The documents with a file were saved before the dialog showed.
    expect(native.writeFile).toHaveBeenCalledTimes(2);
    expect(store.get().tabs).toHaveLength(4);
    expect(store.get().tabs[1]!.doc.isDirty).toBe(false);
    expect(store.get().tabs[2]!.doc.isDirty).toBe(true);
    expect(store.get().tabs[3]!.doc.isDirty).toBe(false);
  });

  it("asks for the saves of all documents with a file at once, so one that does not return holds up no other", async () => {
    const { store, files } = setup(true);
    store.addTab({ ...blankDoc(), filePath: "/local/other.md", markdown: "# Other\n", isDirty: true });
    // The first document is on a network drive that went away.
    native.writeFile.mockImplementation((path) => path === filePath ? new Promise(() => {}) : Promise.resolve({ modifiedMs: 300 }));
    void files.confirmCloseAll();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledWith("/local/other.md", "# Other\n", "lf"));
    expect(store.get().doc).toMatchObject({ filePath: "/local/other.md", isDirty: false });
  });

  it("stops asking where to save untitled documents once a save fails, and leaves no failure unhandled", async () => {
    const closeSaveFailed = vi.fn();
    const { store, files } = setup(true, { closeSaveFailed });
    const filed = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), markdown: "First untitled\n", isDirty: true });
    store.addTab({ ...blankDoc(), markdown: "Second untitled\n", isDirty: true });
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const closing = files.confirmCloseAll();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    // The document with a file fails while the first dialog shows.
    const failure = new Error("Disk unavailable");
    write.reject(failure);
    await eventually(() => expect(closeSaveFailed).toHaveBeenCalledExactlyOnceWith(filed, failure));
    dialog.resolve("/docs/first.md");
    expect(await closing).toBe("cancel");
    expect(native.writeFile).toHaveBeenLastCalledWith("/docs/first.md", "First untitled\n", "lf");
    expect(native.saveDialog).toHaveBeenCalledOnce();
    expect(closeSaveFailed).toHaveBeenCalledOnce();
  });

  it("reports a save that fails while an untitled document's dialog shows, also when the user cancels that dialog", async () => {
    const closeSaveFailed = vi.fn();
    const { store, files } = setup(true, { closeSaveFailed });
    const filed = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), markdown: "Untitled\n", isDirty: true });
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const dialog = deferred<string | null>();
    native.saveDialog.mockReturnValueOnce(dialog.promise);
    const closing = files.confirmCloseAll();
    await eventually(() => expect(native.saveDialog).toHaveBeenCalledOnce());
    const failure = new Error("Disk unavailable");
    write.reject(failure);
    dialog.resolve(null);
    expect(await closing).toBe("cancel");
    expect(closeSaveFailed).toHaveBeenCalledExactlyOnceWith(filed, failure);
  });

  it("reports a close save that fails after the close stopped waiting for it", async () => {
    const closeSaveFailed = vi.fn();
    const { store, files } = setup(true, { closeSaveFailed });
    const tabId = store.get().activeTabId!;
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const stop = new AbortController();
    const closing = files.confirmCloseTab(tabId, "notes.md", stop.signal);
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    stop.abort();
    expect(await closing).toBe("cancel");
    const failure = new Error("Disk unavailable");
    write.reject(failure);
    await eventually(() => expect(closeSaveFailed).toHaveBeenCalledExactlyOnceWith(tabId, failure));
  });

  it("keeps every tab when a close save fails, and reports the failure", async () => {
    const closeSaveFailed = vi.fn();
    const { store, files } = setup(true, { closeSaveFailed });
    const failure = new Error("Disk unavailable");
    native.writeFile.mockRejectedValueOnce(failure);

    expect(await files.confirmCloseAll()).toBe("cancel");
    expect(closeSaveFailed).toHaveBeenCalledExactlyOnceWith(store.get().activeTabId, failure);
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

  it.each([
    { what: "with unsaved changes", dirty: true },
    { what: "without unsaved changes", dirty: false },
  ])("never writes the file that a Save As failing during the close was leaving, nor closes, for a document $what", async ({ dirty }) => {
    const { store, files } = setup(dirty);
    const tabId = store.get().activeTabId!;
    // A Save As to a slow drive, after which the user goes on typing.
    native.saveDialog.mockResolvedValueOnce("/slow/report.md");
    const write = deferred<FileMeta>();
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    if (dirty) store.patchDoc({ markdown: "# Typed during the Save As\n", isDirty: true });
    const closing = files.confirmCloseTab(tabId, "notes.md");
    await eventually(() => expect(native.confirmSaveChanges).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    write.reject(new Error("Disk unavailable"));
    await expect(saveAs).rejects.toThrow("Disk unavailable");
    expect(await closing).toBe("cancel");
    expect(native.writeFile).toHaveBeenCalledOnce();
    expect(store.get().doc.filePath).toBe(filePath);
  });

  it("asks before closing a document whose save does not return, and stops waiting once a newer close takes over", async () => {
    const { store, files } = setup();
    const tabId = store.get().activeTabId!;
    // Save without an edit, to a drive that went away.
    native.writeFile.mockReturnValueOnce(new Promise(() => {}));
    void files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    expect(store.get().doc.isDirty).toBe(false);

    const first = new AbortController();
    const closing = files.confirmCloseTab(tabId, "notes.md", first.signal);
    await eventually(() => expect(native.confirmSaveChanges).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.canCloseTabs([tabId])).toBe(false);
    first.abort();
    expect(await closing).toBe("cancel");

    native.confirmSaveChanges.mockResolvedValueOnce("discard");
    expect(await files.confirmCloseTab(tabId, "notes.md")).toBe("discard");
    expect(native.confirmSaveChanges).toHaveBeenLastCalledWith('"notes.md" has unsaved changes. Save before closing?');
    expect(native.writeFile).toHaveBeenCalledOnce();
  });

  it("closes a tab while another tab's write does not return", async () => {
    const { store, files } = setup(true);
    native.writeFile.mockReturnValueOnce(new Promise(() => {}));
    void files.save();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    const other = store.addTab({ ...blankDoc(), filePath: "/local/other.md", markdown: "# Other\n", isDirty: true });
    expect(await files.confirmCloseTab(other, "other.md")).toBe("close");
    expect(native.writeFile).toHaveBeenLastCalledWith("/local/other.md", "# Other\n", "lf");
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

  it.each([
    { change: "got another file through Save As", patch: { filePath: "/local/notes.md" } },
    { change: "got another file and then new text", patch: { filePath: "/local/notes.md", markdown: "# Typed after the Save As\n", isDirty: true } },
  ])("keeps the document of a tab that $change while its reload read the file", async ({ patch }) => {
    const { store, presenter, files } = setup();
    const owner = store.get().activeTabId!;
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    store.patchDocById(owner, patch);
    const kept = store.get().doc;

    read.resolve(onDisk);
    await loading;

    expect(store.get().doc).toEqual(kept);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("keeps text typed into an empty untitled tab while a file is read, which the editor reports only in its flush", async () => {
    const { store, presenter, files } = setup();
    store.addTab(blankDoc());
    const untitled = store.get().activeTabId!;
    const tabs = store.get().tabs.length;
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const opening = files.openPath("/docs/other.md");
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith("/docs/other.md"));
    presenter.flush.mockImplementationOnce(() => { store.patchDocById(untitled, { markdown: "A draft\n", isDirty: true }); });
    read.resolve(onDisk);
    await opening;
    expect(store.get().tabs).toHaveLength(tabs + 1);
    expect(store.get().tabs.find((tab) => tab.id === untitled)?.doc.markdown).toBe("A draft\n");
    expect(store.get().doc.filePath).toBe("/docs/other.md");
  });

  it("gives a file one tab when a Save As onto it starts while the open reads it", async () => {
    const { store, presenter, files } = setup(true);
    const writer = store.get().activeTabId!;
    const tabs = store.get().tabs.length;
    const read = deferred<FilePayload>();
    const write = deferred<FileMeta>();
    native.readFile.mockReturnValueOnce(read.promise);
    native.writeFile.mockReturnValueOnce(write.promise);
    const opening = files.openPath("/docs/target.md");
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith("/docs/target.md"));
    native.saveDialog.mockResolvedValueOnce("/docs/target.md");
    const saveAs = files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    // The open waits for the save, which gives the file to its tab.
    read.resolve(onDisk);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get().tabs).toHaveLength(tabs);
    write.resolve({ modifiedMs: 300 });
    expect(await saveAs).toBe(true);
    await opening;
    expect(store.get().tabs).toHaveLength(tabs);
    expect(store.get().activeTabId).toBe(writer);
    expect(store.get().doc.filePath).toBe("/docs/target.md");
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("collects typing in the tab that goes behind once its wait for a save ends, before it shows the tab that has the file", async () => {
    const { store, presenter, files } = setup(true);
    const writer = store.get().activeTabId!;
    const other = store.addTab({ ...blankDoc(), filePath: "/docs/other.md", markdown: "# Other\n", savedMarkdown: "# Other\n" });
    store.activateTab(writer);
    const write = deferred<FileMeta>();
    native.saveDialog.mockResolvedValueOnce("/docs/target.md");
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.activateTab(other);
    const opening = files.openPath("/docs/target.md");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // From here on: the editor reports typing only when asked, and the open
    // asks before another tab comes to the front.
    const order: string[] = [];
    presenter.flush.mockImplementation(() => { order.push("collect typing"); });
    const stop = store.select((state) => state.activeTabId, () => { order.push("show another tab"); });
    write.resolve({ modifiedMs: 300 });
    expect(await saveAs).toBe(true);
    await opening;
    stop();
    expect(store.get().activeTabId).toBe(writer);
    expect(order).toEqual(["collect typing", "show another tab"]);
  });

  it("gives a file one tab when it is opened twice before the first read ends", async () => {
    const { store, presenter, files } = setup();
    const tabs = store.get().tabs.length;
    const first = deferred<FilePayload>();
    const second = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const opening = files.openPath("/docs/other.md");
    const again = files.openPath("/docs/other.md");
    await eventually(() => expect(native.readFile).toHaveBeenCalledTimes(2));
    first.resolve(onDisk);
    await opening;
    second.resolve(onDisk);
    await again;
    expect(store.get().tabs).toHaveLength(tabs + 1);
    expect(store.get().doc.filePath).toBe("/docs/other.md");
    // The second open only shows the tab the first one made.
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
    expect(presenter.showActiveDoc).toHaveBeenCalledOnce();
  });

  it.each([
    { end: "works", fails: false },
    { end: "fails", fails: true },
  ])("waits for a Save As that is writing a file when that file is opened, and shows the file in one tab when the save $end", async ({ fails }) => {
    const { store, presenter, files } = setup(true);
    const writer = store.get().activeTabId!;
    const other = store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    const tabs = store.get().tabs.length;
    store.activateTab(writer);
    const write = deferred<FileMeta>();
    native.saveDialog.mockResolvedValueOnce("/docs/target.md");
    native.writeFile.mockReturnValueOnce(write.promise);
    const saveAs = files.saveAs();
    await eventually(() => expect(native.writeFile).toHaveBeenCalledOnce());
    store.activateTab(other);
    const opening = files.openPath("/docs/target.md");
    // Another file opens in a tab of its own meanwhile.
    await files.openPath("/docs/third.md");
    expect(store.get().tabs).toHaveLength(tabs + 1);
    expect(native.readFile).toHaveBeenCalledExactlyOnceWith("/docs/third.md");

    if (fails) {
      write.reject(new Error("Disk unavailable"));
      await expect(saveAs).rejects.toThrow("Disk unavailable");
      await opening;
      // No tab got the file, so the open reads it into a tab of its own.
      expect(native.readFile).toHaveBeenLastCalledWith("/docs/target.md");
      expect(store.get().tabs).toHaveLength(tabs + 2);
      expect(store.get().tabs.find((tab) => tab.id === writer)?.doc.filePath).toBe(filePath);
    } else {
      write.resolve({ modifiedMs: 300 });
      expect(await saveAs).toBe(true);
      await opening;
      // The open shows the tab that the save gave the file to.
      expect(native.readFile).toHaveBeenCalledOnce();
      expect(store.get().activeTabId).toBe(writer);
      expect(presenter.showActiveDoc).toHaveBeenCalledOnce();
      expect(store.get().tabs).toHaveLength(tabs + 1);
    }
    expect(store.get().tabs.filter((tab) => tab.doc.filePath === "/docs/target.md")).toHaveLength(1);
  });

  it("says nothing about a reload's failed read once its tab shows another file", async () => {
    const { store, presenter, files } = setup();
    const owner = store.get().activeTabId!;
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    store.patchDocById(owner, { filePath: "/local/notes.md" });
    read.reject(new Error("The share went away."));
    await expect(loading).resolves.toBeUndefined();
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();

    // A failed read of the file the tab still shows is told.
    native.readFile.mockRejectedValueOnce(new Error("The share went away."));
    await expect(files.openPath("/local/notes.md", { reload: true })).rejects.toThrow("The share went away.");
  });

  it("replaces text typed during a reload's read with the file, as the user asked", async () => {
    const { store, presenter, files } = setup();
    const owner = store.get().activeTabId!;
    const read = deferred<FilePayload>();
    native.readFile.mockReturnValueOnce(read.promise);
    const loading = files.openPath(filePath, { reload: true });
    await eventually(() => expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath));
    store.patchDocById(owner, { markdown: "# Typed during the read\n", isDirty: true });

    read.resolve(onDisk);
    await loading;

    expect(store.get().doc).toMatchObject({ filePath, markdown: onDisk.content, isDirty: false });
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
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
    // The other tab's typing is collected before the reloaded one comes to the front.
    const order: string[] = [];
    presenter.flush.mockImplementation(() => { order.push("collect typing"); });
    const stop = store.select((state) => state.activeTabId, () => { order.push("show another tab"); });

    read.resolve(onDisk);
    await loading;
    stop();
    expect(order).toEqual(["collect typing", "show another tab"]);

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
