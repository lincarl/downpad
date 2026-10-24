// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { ElectronBridge } from "../ipc/bridge";
import type { FileMeta, FilePayload } from "../ipc/contracts";
import type { FileChangedPayload } from "../ipc/events";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { Eol } from "../state/types";
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
  let current: Promise<unknown>;

  beforeEach(() => {
    bridge = createTestBridge();
    window.downpad = bridge;
    const store = createAppStore();
    files = new FileService(store, {
      flush: () => {},
      showActiveDoc: async () => {},
      reloadActiveDoc: async () => {},
    });
    host = new EditorHost(document.createElement("div"), store);
    scheduler = new SnapshotScheduler(store, files);
    vi.spyOn(host, "flush").mockImplementation(() => {});
    vi.spyOn(files, "anyDirty").mockReturnValue(false);
    vi.spyOn(files, "confirmDiscardAll").mockResolvedValue(true);
    vi.spyOn(scheduler, "clear").mockResolvedValue(undefined);
    current = Promise.resolve();
    bindings = new DesktopEventBindings({
      store,
      files,
      editorHost: host,
      scheduler,
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
    delete window.downpad;
    vi.restoreAllMocks();
  });

  it("flushes edits and clears recovery before approving native close", async () => {
    events.closeRequested!();
    await current;

    expect(host.flush).toHaveBeenCalledOnce();
    expect(scheduler.clear).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
    expect(bridge.cancelWindowClose).not.toHaveBeenCalled();
    expect(vi.mocked(scheduler.clear).mock.invocationCallOrder[0])
      .toBeLessThan(bridge.closeWindow.mock.invocationCallOrder[0]!);
  });

  it("cancels quit intent after declining discard and accepts a later close", async () => {
    vi.mocked(files.anyDirty).mockReturnValue(true);
    vi.mocked(files.confirmDiscardAll).mockResolvedValueOnce(false);
    events.closeRequested!();
    await current;

    expect(bridge.cancelWindowClose).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(scheduler.clear).not.toHaveBeenCalled();

    events.closeRequested!();
    await current;

    expect(files.confirmDiscardAll).toHaveBeenCalledTimes(2);
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
});

describe("a file that changed on disk", () => {
  const filePath = "/docs/notes.md";
  let store: ReturnType<typeof createAppStore>;
  let bindings: DesktopEventBindings;
  let host: EditorHost;
  let files: FileService;

  beforeEach(() => {
    window.downpad = createTestBridge();
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
      handleDrop: async () => {},
      run: () => {},
    });
    bindings.start();
  });

  afterEach(async () => {
    bindings.dispose();
    await host.dispose();
    delete window.downpad;
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
