// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { ElectronBridge } from "../ipc/bridge";
import type { FileMeta, FilePayload, FileStamp } from "../ipc/contracts";
import type { FileChangedPayload } from "../ipc/events";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import { blankDoc, type Eol } from "../state/types";
import { createAppStore } from "./createAppStore";
import { DesktopEventBindings } from "./DesktopEventBindings";

const events = vi.hoisted(() => ({
  closeRequested: null as (() => void) | null,
  fileChanged: null as ((payload: FileChangedPayload) => void) | null,
}));
const disk = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<FilePayload>>(),
  writeFile: vi.fn<(path: string, content: string, eol: Eol) => Promise<FileMeta>>(),
  fileStamp: vi.fn<(path: string) => Promise<FileStamp>>(),
}));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  readFile: disk.readFile,
  writeFile: disk.writeFile,
  fileStamp: disk.fileStamp,
}));

vi.mock("../ipc/events", () => ({
  onFileChanged: async (handler: (payload: FileChangedPayload) => void) => {
    events.fileChanged = handler;
    return () => { events.fileChanged = null; };
  },
  onOpenFileRequested: async () => () => {},
  onHistoryRequested: async () => () => {},
  onCloseRequested: async (handler: () => void) => {
    events.closeRequested = handler;
    return () => { events.closeRequested = null; };
  },
}));

/** A file's stamp at `modifiedMs`, with a size the documents in these tests
 *  do not record. */
const stamp = (modifiedMs: number): FileStamp => ({ modifiedMs, sizeBytes: 0 });

beforeEach(() => {
  disk.readFile.mockReset();
  disk.fileStamp.mockReset();
  // The file as the documents in these tests recorded it.
  disk.fileStamp.mockResolvedValue(stamp(100));
  disk.readFile.mockResolvedValue({ content: "# Mine\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 7 });
  disk.writeFile.mockReset();
});

/** Retry an assertion every millisecond. The awaited calls happen a few
 *  microtasks later, so vi.waitFor's default 50 ms interval cost each wait a
 *  whole interval. */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { interval: 1 });

function createTestBridge() {
  return {
    platform: "darwin",
    checkSpelling: async () => [],
    spellingSuggestions: async () => [],
    invoke: async () => { throw new Error("Unexpected native command"); },
    listen: () => () => {},
    openDialog: async () => null,
    saveDialog: async () => null,
    ask: async () => false,
    confirmSaveChanges: vi.fn<ElectronBridge["confirmSaveChanges"]>(async () => "cancel"),
    openExternal: async () => {},
    revealItemInFolder: async () => {},
    setTheme: async () => {},
    getPathForFile: () => "",
    convertFileSrc: async (path: string) => path,
    closeWindow: vi.fn(async () => {}),
    cancelWindowClose: vi.fn(async () => {}),
  } satisfies ElectronBridge;
}

describe("native close decisions", () => {
  let bridge: ReturnType<typeof createTestBridge>;
  let bindings: DesktopEventBindings;
  let host: EditorHost;
  let files: FileService;
  let scheduler: SnapshotScheduler;
  let session: { flush: ReturnType<typeof vi.fn<() => Promise<void>>> };
  let current: Promise<unknown>;
  let store: ReturnType<typeof createAppStore>;

  beforeEach(() => {
    bridge = createTestBridge();
    window.downpadDesktop = bridge;
    store = createAppStore();
    files = new FileService(store, {
      flush: () => {},
      showActiveDoc: async () => {},
      reloadActiveDoc: async () => {},
    });
    host = new EditorHost(document.createElement("div"), store);
    scheduler = new SnapshotScheduler(store, files);
    vi.spyOn(host, "flush").mockImplementation(() => {});
    vi.spyOn(files, "confirmCloseAll").mockResolvedValue("close");
    vi.spyOn(scheduler, "clear").mockResolvedValue(undefined);
    vi.spyOn(scheduler, "start").mockImplementation(() => {});
    session = { flush: vi.fn(async () => {}) };
    current = Promise.resolve();
    bindings = new DesktopEventBindings({
      store,
      files,
      editorHost: host,
      scheduler,
      session,
      handleDrop: async () => {},
      run: (action) => {
        current = action();
        void current.catch(() => {});
      },
    });
    bindings.start();
  });

  afterEach(async () => {
    bindings.dispose();
    await host.dispose();
    delete window.downpadDesktop;
    vi.restoreAllMocks();
  });

  it("flushes edits, clears recovery and records the open documents before approving native close", async () => {
    events.closeRequested!();
    await current;

    expect(host.flush).toHaveBeenCalledOnce();
    expect(scheduler.clear).toHaveBeenCalledOnce();
    expect(session.flush).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
    expect(bridge.cancelWindowClose).not.toHaveBeenCalled();
    expect(vi.mocked(scheduler.clear).mock.invocationCallOrder[0])
      .toBeLessThan(bridge.closeWindow.mock.invocationCallOrder[0]!);
    expect(session.flush.mock.invocationCallOrder[0]).toBeLessThan(bridge.closeWindow.mock.invocationCallOrder[0]!);
  });

  it("does not close while the open documents are still being recorded", async () => {
    let recorded!: () => void;
    session.flush.mockReturnValueOnce(new Promise<void>((resolve) => { recorded = resolve; }));
    events.closeRequested!();
    await eventually(() => expect(session.flush).toHaveBeenCalledOnce());
    expect(bridge.closeWindow).not.toHaveBeenCalled();

    recorded();
    await current;
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
  });

  it("cancels quit intent after declining discard and accepts a later close", async () => {
    vi.mocked(files.confirmCloseAll).mockResolvedValueOnce("cancel").mockResolvedValueOnce("discard");
    store.addTab({ ...blankDoc(), filePath: "/docs/closing.md", markdown: "Unsaved text\n", isDirty: true });
    events.closeRequested!();
    await current;

    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(scheduler.clear).not.toHaveBeenCalled();

    // Discard closes the window with the document still unsaved.
    events.closeRequested!();
    await current;

    expect(files.confirmCloseAll).toHaveBeenCalledTimes(2);
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
    expect(store.get().doc.isDirty).toBe(true);
  });

  it("cancels quit intent when preparing the close fails", async () => {
    vi.mocked(scheduler.clear).mockRejectedValueOnce(new Error("Recovery cleanup failed"));
    events.closeRequested!();

    await expect(current).rejects.toThrow("Recovery cleanup failed");
    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).not.toHaveBeenCalled();
  });

  it("waits for Save before clearing recovery and closing the window", async () => {
    vi.mocked(files.confirmCloseAll).mockRestore();
    bridge.confirmSaveChanges.mockResolvedValueOnce("save");
    store.addTab({ ...blankDoc(), filePath: "/docs/closing.md", markdown: "Unsaved text\n", isDirty: true });
    let finishWrite!: (meta: FileMeta) => void;
    disk.writeFile.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    events.closeRequested!();
    const closing = current;
    await eventually(() => expect(disk.writeFile).toHaveBeenCalledWith("/docs/closing.md", "Unsaved text\n", "lf"));
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(scheduler.clear).not.toHaveBeenCalled();
    // Repeated native close events share the pending close instead of prompting again.
    events.closeRequested!();
    finishWrite({ modifiedMs: 200 });
    await closing;

    expect(bridge.confirmSaveChanges).toHaveBeenCalledOnce();
    expect(scheduler.clear).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
  });

  it("cancels native close and retains recovery when Save fails", async () => {
    vi.mocked(files.confirmCloseAll).mockRestore();
    bridge.confirmSaveChanges.mockResolvedValueOnce("save");
    store.addTab({ ...blankDoc(), filePath: "/docs/closing.md", markdown: "Unsaved text\n", isDirty: true });
    disk.writeFile.mockRejectedValueOnce(new Error("Disk full"));
    events.closeRequested!();

    await expect(current).rejects.toThrow("Disk full");
    expect(scheduler.clear).not.toHaveBeenCalled();
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(store.get().doc.isDirty).toBe(true);
  });

  it.each(["typing", "dropped assets"])("restarts recovery when %s arrives during recovery cleanup", async (change) => {
    const owner = store.addTab({ ...blankDoc(), filePath: "/docs/closing.md" });
    let finishCleanup!: () => void;
    vi.mocked(scheduler.clear).mockImplementationOnce(() => new Promise((resolve) => { finishCleanup = resolve; }));
    events.closeRequested!();
    await eventually(() => expect(scheduler.clear).toHaveBeenCalledOnce());
    if (change === "typing") store.patchDoc({ markdown: "Later edits\n", isDirty: true });
    else store.setFilesPending(owner, true);
    finishCleanup();
    await current;

    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(scheduler.start).toHaveBeenCalledOnce();
  });
});

describe("a file that changed on disk", () => {
  const filePath = "/docs/notes.md";
  let store: ReturnType<typeof createAppStore>;
  let bindings: DesktopEventBindings;
  let host: EditorHost;
  let files: FileService;

  beforeEach(() => {
    window.downpadDesktop = createTestBridge();
    store = createAppStore();
    store.patchDoc({ filePath, markdown: "# Mine\n", savedMarkdown: "# Mine\n", isDirty: false, modifiedMs: 100 });
    files = new FileService(store, {
      flush: () => {},
      showActiveDoc: async () => {},
      reloadActiveDoc: async () => {},
    });
    host = new EditorHost(document.createElement("div"), store);
    bindings = new DesktopEventBindings({
      store,
      files,
      editorHost: host,
      scheduler: new SnapshotScheduler(store, files),
      session: { flush: async () => {} },
      handleDrop: async () => {},
      run: () => {},
    });
    bindings.start();
  });

  afterEach(async () => {
    bindings.dispose();
    await host.dispose();
    delete window.downpadDesktop;
    vi.restoreAllMocks();
  });

  /** Report that the open file now holds `content`, and let the app read it. */
  async function changeOnDisk(content: string, modifiedMs = 200): Promise<void> {
    disk.readFile.mockResolvedValueOnce({ content, eol: "lf", hadBom: false, modifiedMs, sizeBytes: content.length });
    await eventually(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!({ path: filePath, modifiedMs });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it.each([
    {
      report: "a change to another file",
      prepare: async (): Promise<FileChangedPayload> => ({ path: "/docs/other.md", modifiedMs: 999 }),
    },
    {
      report: "a change for an untitled document",
      prepare: async (): Promise<FileChangedPayload> => {
        store.patchDoc({ filePath: null });
        // A Windows path, which sameFilePath cannot compare with no path.
        return { path: "C:/docs/notes.md", modifiedMs: 999 };
      },
    },
  ])("ignores $report", async ({ prepare }) => {
    const payload = await prepare();
    const before = store.get().doc;
    // What the file holds after the save, which differs from the open text.
    disk.readFile.mockResolvedValue({ content: "# Mine\n", eol: "lf", hadBom: false, modifiedMs: payload.modifiedMs, sizeBytes: 7 });
    await eventually(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disk.readFile).not.toHaveBeenCalled();
    expect(store.get().banner).toBeNull();
    expect(store.get().doc).toBe(before);
  });

  it("takes its own save during later typing for no change on disk", async () => {
    disk.writeFile.mockResolvedValueOnce({ modifiedMs: 200 });
    expect(await files.save()).toBe(true);
    store.patchDoc({ markdown: "# Mine\n\nMore typing\n", isDirty: true });
    // What the file holds after the save, which differs from the open text.
    disk.readFile.mockResolvedValue({ content: "# Mine\n", eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: 7 });
    await eventually(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!({ path: filePath, modifiedMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get().banner).toBeNull();
    expect(store.get().doc).toMatchObject({ markdown: "# Mine\n\nMore typing\n", savedMarkdown: "# Mine\n", isDirty: true, modifiedMs: 200 });
  });

  it("counts the open text as unsaved once the user keeps it", async () => {
    await changeOnDisk("# Theirs\n");
    expect(store.get().doc.isDirty).toBe(false);

    bindings.handleBannerAction("keep");

    expect(store.get().banner).toBeNull();
    expect(store.get().doc).toMatchObject({ modifiedMs: 200, savedMarkdown: "# Theirs\n", isDirty: true });
  });

  it("counts unsaved text as saved when the file now holds it", async () => {
    store.patchDoc({ savedMarkdown: "# Older\n", isDirty: true });

    await changeOnDisk("# Mine\n");

    expect(store.get().banner).toBeNull();
    expect(store.get().doc).toMatchObject({ modifiedMs: 200, savedMarkdown: "# Mine\n", isDirty: false });
  });

  it("leaves the document saved when the user keeps it after Save", async () => {
    await changeOnDisk("# Theirs\n");
    disk.writeFile.mockResolvedValueOnce({ modifiedMs: 300 });
    expect(await files.save()).toBe(true);

    bindings.handleBannerAction("keep");

    expect(store.get().banner).toBeNull();
    expect(store.get().doc).toMatchObject({ modifiedMs: 300, savedMarkdown: "# Mine\n", isDirty: false });
  });

  it("asks again about a dismissed change until a save replaces it", async () => {
    await changeOnDisk("# Theirs\n");
    store.set({ banner: null });

    expect(bindings.showPendingChange()).toBe(true);
    expect(store.get().banner?.kind).toBe("file-changed");

    store.set({ banner: null });
    disk.writeFile.mockResolvedValueOnce({ modifiedMs: 300 });
    expect(await files.save()).toBe(true);

    expect(bindings.showPendingChange()).toBe(false);
    expect(store.get().banner).toBeNull();
  });

  it("forgets a dismissed change once Save As gives the document another file, also one dated earlier", async () => {
    // The other program's clock runs ahead.
    await changeOnDisk("# Theirs\n", 10_000);
    store.set({ banner: null });
    window.downpadDesktop!.saveDialog = async () => "/docs/copy.md";
    disk.writeFile.mockResolvedValueOnce({ modifiedMs: 300 });
    expect(await files.saveAs()).toBe(true);
    expect(store.get().doc.filePath).toBe("/docs/copy.md");

    expect(bindings.showPendingChange()).toBe(false);
    expect(store.get().banner).toBeNull();
  });

  it("shows a dismissed change again once its tab is in front again, and holds autosave for it", async () => {
    await changeOnDisk("# Theirs\n");
    disk.fileStamp.mockResolvedValue(stamp(200));
    const first = store.get().activeTabId!;
    expect(bindings.holdSave()).toBe(true);

    // Another tab comes to the front, as the app clears the bar then.
    store.addTab({ ...blankDoc(), markdown: "# Other\n" });
    store.set({ banner: null });
    bindings.activeDocChanged();
    expect(bindings.holdSave()).toBe(false);
    expect(store.get().banner).toBeNull();

    // The tab's return reads the file, which still holds the change.
    disk.readFile.mockResolvedValueOnce({ content: "# Theirs\n", eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: 9 });
    store.activateTab(first);
    bindings.activeDocChanged();
    expect(store.get().banner?.kind).toBe("file-changed");
    expect(bindings.holdSave()).toBe(true);
    await eventually(() => expect(disk.readFile).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get().banner?.kind).toBe("file-changed");
    expect(bindings.holdSave()).toBe(true);
  });

  it("drops a notice once the file holds the saved text again, also with the change's time and size", async () => {
    store.patchDoc({ fileSize: 7 });
    await changeOnDisk("# Peer\n", 100);
    const first = store.get().activeTabId!;
    expect(bindings.holdSave()).toBe(true);

    // While another tab is in front, a sync tool puts the earlier text back
    // and keeps the file's time and size.
    store.addTab({ ...blankDoc(), markdown: "# Other\n" });
    store.set({ banner: null });
    bindings.activeDocChanged();
    disk.fileStamp.mockResolvedValue({ modifiedMs: 100, sizeBytes: 7 });
    store.activateTab(first);
    bindings.activeDocChanged();
    await eventually(() => expect(store.get().banner).toBeNull());
    expect(bindings.holdSave()).toBe(false);
  });

  it("notices a change made while another tab was in front, also in a file dated 1970, but not for a recovered document", async () => {
    const first = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), markdown: "# Other\n" });
    bindings.activeDocChanged();
    disk.readFile.mockResolvedValue({ content: "# Theirs\n", eol: "lf", hadBom: false, modifiedMs: 300, sizeBytes: 9 });
    disk.fileStamp.mockResolvedValue(stamp(300));
    store.activateTab(first);
    bindings.activeDocChanged();
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
    bindings.handleBannerAction("keep");
    expect(store.get().doc).toMatchObject({ modifiedMs: 300, savedMarkdown: "# Theirs\n", isDirty: true });

    // A recovered document has no file time, so only the watcher tells.
    disk.readFile.mockClear();
    store.addTab({ ...blankDoc(), markdown: "# Recovered\n", filePath: "/docs/recovered.md", modifiedMs: 0, savedMarkdown: null, isDirty: true });
    bindings.activeDocChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disk.readFile).not.toHaveBeenCalled();
    expect(store.get().banner).toBeNull();

    // A file dated 1970 has the time 0, but a version of its own.
    store.addTab({ ...blankDoc(), markdown: "# Mine\n", savedMarkdown: "# Mine\n", filePath: "/docs/dated.md", modifiedMs: 0, fileSize: 7 });
    bindings.activeDocChanged();
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
    expect(disk.readFile).toHaveBeenCalledWith("/docs/dated.md");
  });

  it("drops a change for the old file after Save As, and notices edits of the new file", async () => {
    // The other program's clock runs ahead.
    await changeOnDisk("# Theirs\n", 10_000);
    expect(store.get().banner?.kind).toBe("file-changed");
    window.downpadDesktop!.saveDialog = async () => "/docs/copy.md";
    disk.writeFile.mockResolvedValueOnce({ modifiedMs: 300 });
    expect(await files.saveAs()).toBe(true);
    expect(store.get().banner).toBeNull();

    disk.readFile.mockResolvedValueOnce({ content: "# Other\n", eol: "lf", hadBom: false, modifiedMs: 400, sizeBytes: 8 });
    events.fileChanged!({ path: "/docs/copy.md", modifiedMs: 400 });
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
  });

  it("notices a file replaced by one with an older time, and Keep mine and Reload take it", async () => {
    await changeOnDisk("# Theirs\n", 200);
    // A backup with an older time replaces the file.
    await changeOnDisk("# Backup\n", 50);
    bindings.handleBannerAction("keep");
    expect(store.get().doc).toMatchObject({ modifiedMs: 50, savedMarkdown: "# Backup\n", isDirty: true });

    await changeOnDisk("# Older still\n", 40);
    expect(store.get().banner?.kind).toBe("file-changed");
    bindings.handleBannerAction("reload");
    // The reload shows the file and clears the bar, as the app does.
    store.set({ banner: null });
    store.patchDoc({ markdown: "# Older still\n", savedMarkdown: "# Older still\n", modifiedMs: 40, fileSize: 14, isDirty: false });
    disk.fileStamp.mockResolvedValue({ modifiedMs: 40, sizeBytes: 14 });
    bindings.activeDocChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get().banner).toBeNull();
  });

  it("reads the file again when its tab comes back with a notice, so Keep mine keeps the latest version", async () => {
    await changeOnDisk("# Theirs\n", 200);
    const first = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), markdown: "# Other\n" });
    store.set({ banner: null });
    bindings.activeDocChanged();
    // The file changes again while its tab is in back.
    disk.fileStamp.mockResolvedValue(stamp(300));
    disk.readFile.mockResolvedValueOnce({ content: "# Theirs, later\n", eol: "lf", hadBom: false, modifiedMs: 300, sizeBytes: 16 });
    store.activateTab(first);
    bindings.activeDocChanged();
    await eventually(() => expect(disk.readFile).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    bindings.handleBannerAction("keep");
    expect(store.get().doc).toMatchObject({ modifiedMs: 300, savedMarkdown: "# Theirs, later\n" });
  });

  it("takes the app's own save under way for no change on disk", async () => {
    let finish!: (meta: FileMeta) => void;
    disk.writeFile.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    // With the size of the version it recorded, as every opened document has,
    // so a save under way does not make it look recovered.
    store.patchDoc({ markdown: "# Saving\n", isDirty: true, fileSize: 7 });
    const saving = files.save();
    await eventually(() => expect(disk.writeFile).toHaveBeenCalledOnce());
    store.patchDoc({ markdown: "# Saving, and more\n", isDirty: true });
    // The file holds the new text, or still the old one.
    for (const content of ["# Saving\n", "# Mine\n"]) {
      disk.fileStamp.mockResolvedValueOnce(stamp(200));
      disk.readFile.mockResolvedValueOnce({ content, eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: content.length });
      bindings.activeDocChanged();
      await eventually(() => expect(disk.readFile.mock.results.at(-1)?.value).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.get().banner).toBeNull();
    }
    finish({ modifiedMs: 200 });
    expect(await saving).toBe(true);
  });

  it("holds automatic saves while it compares a tab with its file, and shows a dismissed notice when it holds one", async () => {
    let answer!: (value: FileStamp) => void;
    disk.fileStamp.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    bindings.activeDocChanged();
    expect(bindings.holdSave()).toBe(true);
    answer(stamp(100));
    await eventually(() => expect(bindings.holdSave()).toBe(false));
    // The time is the one the document recorded, so the file is not read.
    expect(disk.readFile).not.toHaveBeenCalled();

    await changeOnDisk("# Theirs\n");
    store.set({ banner: null });
    expect(bindings.holdSave()).toBe(true);
    expect(store.get().banner?.kind).toBe("file-changed");
  });

  it("keeps holding automatic saves when the user cancels Reload", async () => {
    await changeOnDisk("# Theirs\n");
    // The reload asks about the unsaved text, and the user cancels, so the
    // document stays as it is. This test's run() runs nothing.
    bindings.handleBannerAction("reload");
    store.set({ banner: null });
    expect(bindings.holdSave()).toBe(true);
    expect(store.get().banner?.kind).toBe("file-changed");
  });

  it("compares a tab with its file as soon as it comes to the front, and holds saves of the tab it names", async () => {
    await changeOnDisk("# Theirs\n");
    const first = store.get().activeTabId!;
    store.addTab({ ...blankDoc(), markdown: "# Other\n", filePath: "/docs/other.md", modifiedMs: 100, savedMarkdown: "# Other\n" });
    const second = store.get().activeTabId!;
    await bindings.settled(second);
    // The change of the tab in back holds its saves without showing its bar.
    store.set({ banner: null });
    expect(bindings.holdSave(first)).toBe(true);
    expect(store.get().banner).toBeNull();
    expect(bindings.holdSave(second)).toBe(false);

    store.activateTab(first);
    await bindings.settled(first);
    let answer!: (value: FileStamp) => void;
    disk.fileStamp.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    store.activateTab(second);
    // Before the editor shows the tab, its comparison runs already.
    expect(bindings.holdSave(second)).toBe(true);
    const settled = bindings.settled(second);
    answer(stamp(100));
    await settled;
    expect(bindings.holdSave(second)).toBe(false);
  });

  it("does not use a read that a save made out of date", async () => {
    let finishRead!: (payload: FilePayload) => void;
    disk.fileStamp.mockResolvedValueOnce(stamp(200));
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    bindings.activeDocChanged();
    await eventually(() => expect(disk.readFile).toHaveBeenCalledOnce());
    // The user saves before the read ends, which records another version.
    store.patchDoc({ modifiedMs: 300, savedMarkdown: "# Mine\n" });
    finishRead({ content: "# Theirs\n", eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get().banner).toBeNull();
    expect(bindings.holdSave()).toBe(false);
  });

  it("notices a replacement that keeps the file's time, and one that only changes its size", async () => {
    // The watcher reports the time the document recorded.
    await changeOnDisk("# Theirs, same time\n", 100);
    expect(store.get().banner?.kind).toBe("file-changed");
    bindings.handleBannerAction("keep");

    // The size the document recorded tells a tab coming back that the file changed.
    store.patchDoc({ fileSize: 21 });
    disk.fileStamp.mockResolvedValueOnce({ modifiedMs: 100, sizeBytes: 30 });
    disk.readFile.mockResolvedValueOnce({ content: "# Theirs, same time again\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 30 });
    bindings.activeDocChanged();
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
  });

  it("lets a reload resolve a change that kept the file's time", async () => {
    await changeOnDisk("# Theirs\n", 100);
    expect(store.get().banner?.kind).toBe("file-changed");
    // The reload shows the file, as the app does, with the same time.
    store.patchDoc({ markdown: "# Theirs\n", savedMarkdown: "# Theirs\n", modifiedMs: 100, isDirty: false });
    expect(store.get().banner).toBeNull();
    expect(bindings.holdSave()).toBe(false);
  });

  it("lets a reload resolve a change when it records a third text with the change's time and size", async () => {
    await changeOnDisk("# Theirs\n", 100);
    expect(store.get().banner?.kind).toBe("file-changed");
    // Another program replaces the file again and keeps its time and size,
    // and the reload shows that text.
    disk.fileStamp.mockResolvedValue({ modifiedMs: 100, sizeBytes: 9 });
    disk.readFile.mockResolvedValue({ content: "# Third!\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 9 });
    store.patchDoc({ markdown: "# Third!\n", savedMarkdown: "# Third!\n", modifiedMs: 100, fileSize: 9, isDirty: false });
    await eventually(() => expect(store.get().banner).toBeNull());
    expect(bindings.holdSave()).toBe(false);
  });

  it("reads the file again when Keep mine makes a read out of date, and keeps the read of a real edit after a touch", async () => {
    await changeOnDisk("# Theirs\n", 200);
    let finishRead!: (payload: FilePayload) => void;
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    events.fileChanged!({ path: filePath, modifiedMs: 300 });
    await eventually(() => expect(disk.readFile).toHaveBeenCalledTimes(2));
    // The user keeps their text before that read ends.
    bindings.handleBannerAction("keep");
    const later = { content: "# Theirs, later\n", eol: "lf" as const, hadBom: false, modifiedMs: 300, sizeBytes: 16 };
    disk.readFile.mockResolvedValueOnce(later);
    finishRead(later);
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
    bindings.handleBannerAction("keep");
    expect(store.get().doc).toMatchObject({ savedMarkdown: "# Theirs, later\n", modifiedMs: 300 });

    // A touch that keeps the text finishes while the read of a real edit runs.
    let finishEdit!: (payload: FilePayload) => void;
    disk.readFile.mockResolvedValueOnce({ content: "# Theirs, later\n", eol: "lf", hadBom: false, modifiedMs: 350, sizeBytes: 16 });
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => (finishEdit = resolve)));
    events.fileChanged!({ path: filePath, modifiedMs: 350 });
    events.fileChanged!({ path: filePath, modifiedMs: 400 });
    await eventually(() => expect(store.get().doc.modifiedMs).toBe(350));
    finishEdit({ content: "# Edited elsewhere\n", eol: "lf", hadBom: false, modifiedMs: 400, sizeBytes: 19 });
    await eventually(() => expect(store.get().banner?.kind).toBe("file-changed"));
  });

  it("keeps a recheck and callers waiting through the read that an out-of-date read starts", async () => {
    await changeOnDisk("# Theirs\n", 200);
    const tabId = store.get().activeTabId!;
    let finishFirst!: (payload: FilePayload) => void;
    let finishSecond!: (payload: FilePayload) => void;
    disk.readFile
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (finishSecond = resolve)));
    let rechecked = false;
    void bindings.recheck().then(() => (rechecked = true));
    await eventually(() => expect(disk.readFile).toHaveBeenCalledTimes(2));
    bindings.handleBannerAction("keep");
    let settled = false;
    void bindings.settled(tabId).then(() => (settled = true));
    const later = { content: "# Theirs, later\n", eol: "lf" as const, hadBom: false, modifiedMs: 300, sizeBytes: 16 };
    finishFirst(later);
    await eventually(() => expect(disk.readFile).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(rechecked).toBe(false);
    expect(bindings.holdSave(tabId)).toBe(true);
    finishSecond(later);
    await eventually(() => expect(settled && rechecked).toBe(true));
    expect(store.get().banner?.kind).toBe("file-changed");
  });

  it("takes a save of a tab in back as making its slow read out of date", async () => {
    const first = store.get().activeTabId!;
    let finishRead!: (payload: FilePayload) => void;
    disk.fileStamp.mockResolvedValueOnce(stamp(200));
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    bindings.activeDocChanged();
    await eventually(() => expect(disk.readFile).toHaveBeenCalledOnce());
    // The user saves the tab, and switches away and back while the read runs.
    store.addTab({ ...blankDoc(), markdown: "# Other\n" });
    store.patchDocById(first, { savedMarkdown: "# Saved since\n", markdown: "# Saved since\n", modifiedMs: 300 });
    disk.fileStamp.mockResolvedValue(stamp(300));
    disk.readFile.mockResolvedValue({ content: "# Saved since\n", eol: "lf", hadBom: false, modifiedMs: 300, sizeBytes: 14 });
    store.activateTab(first);
    await eventually(() => expect(disk.fileStamp).toHaveBeenCalledTimes(2));
    finishRead({ content: "# Mine\n", eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: 7 });
    await bindings.settled(first);
    expect(store.get().banner).toBeNull();
    expect(bindings.holdSave(first)).toBe(false);
  });

  it("keeps a newer change when an older read finishes after it", async () => {
    // The read for the change at 200 waits until the change at 300 is read.
    let finishOlderRead!: (payload: FilePayload) => void;
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => { finishOlderRead = resolve; }));
    await eventually(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!({ path: filePath, modifiedMs: 200 });
    await changeOnDisk("# Theirs\n", 300);
    finishOlderRead({ content: "# Mine\n", eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get().banner?.kind).toBe("file-changed");
    bindings.handleBannerAction("keep");
    expect(store.get().doc).toMatchObject({ modifiedMs: 300, savedMarkdown: "# Theirs\n", isDirty: true });
  });

  it("drops the banner and leaves the document saved when the file changes back", async () => {
    await changeOnDisk("# Theirs\n");
    expect(store.get().banner?.kind).toBe("file-changed");

    await changeOnDisk("# Mine\n", 250);
    expect(store.get().banner).toBeNull();
    bindings.handleBannerAction("keep");

    expect(store.get().doc).toMatchObject({ modifiedMs: 250, savedMarkdown: "# Mine\n", isDirty: false });
  });
});
