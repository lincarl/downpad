// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { ElectronBridge } from "../ipc/bridge";
import type { FileMeta, FilePayload } from "../ipc/contracts";
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
}));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  readFile: disk.readFile,
  writeFile: disk.writeFile,
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

function createTestBridge() {
  return {
    platform: "darwin",
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
    await vi.waitFor(() => expect(session.flush).toHaveBeenCalledOnce());
    expect(bridge.closeWindow).not.toHaveBeenCalled();

    recorded();
    await current;
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
  });

  it("cancels quit intent after declining discard and accepts a later close", async () => {
    vi.mocked(files.confirmCloseAll).mockResolvedValueOnce("cancel").mockResolvedValueOnce("discard");
    events.closeRequested!();
    await current;

    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(scheduler.clear).not.toHaveBeenCalled();

    events.closeRequested!();
    await current;

    expect(files.confirmCloseAll).toHaveBeenCalledTimes(2);
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(disk.writeFile).toHaveBeenCalledWith("/docs/closing.md", "Unsaved text\n", "lf"));
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
    await vi.waitFor(() => expect(scheduler.clear).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!({ path: filePath, modifiedMs });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

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

  it("keeps a newer change when an older read finishes after it", async () => {
    // The read for the change at 200 waits until the change at 300 is read.
    let finishOlderRead!: (payload: FilePayload) => void;
    disk.readFile.mockImplementationOnce(() => new Promise((resolve) => { finishOlderRead = resolve; }));
    await vi.waitFor(() => expect(events.fileChanged).not.toBeNull());
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
