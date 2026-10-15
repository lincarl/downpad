// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { ElectronBridge } from "../ipc/bridge";
import type { FilePayload } from "../ipc/contracts";
import type { FileChangedPayload } from "../ipc/events";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import { createAppStore } from "./createAppStore";
import { DesktopEventBindings } from "./DesktopEventBindings";

const events = vi.hoisted(() => ({
  closeRequested: null as (() => void) | null,
  fileChanged: null as ((payload: FileChangedPayload) => void) | null,
}));
const disk = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<FilePayload>>() }));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  readFile: disk.readFile,
}));

vi.mock("../ipc/events", () => ({
  onFileChanged: async (handler: (payload: FileChangedPayload) => void) => {
    events.fileChanged = handler;
    return () => { events.fileChanged = null; };
  },
  onOpenFileRequested: async () => () => {},
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
    window.mdEasy = bridge;
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
    delete window.mdEasy;
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

  beforeEach(() => {
    window.mdEasy = createTestBridge();
    store = createAppStore();
    store.patchDoc({ filePath, markdown: "# Mine\n", savedMarkdown: "# Mine\n", isDirty: false, modifiedMs: 100 });
    const files = new FileService(store, {
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
    delete window.mdEasy;
    vi.restoreAllMocks();
  });

  /** Report that the open file now holds `content`. */
  async function changeOnDisk(content: string): Promise<void> {
    disk.readFile.mockResolvedValueOnce({ content, eol: "lf", hadBom: false, modifiedMs: 200, sizeBytes: content.length });
    await vi.waitFor(() => expect(events.fileChanged).not.toBeNull());
    events.fileChanged!({ path: filePath, modifiedMs: 200 });
    await vi.waitFor(() => expect(store.get().doc.modifiedMs === 200 || store.get().banner !== null).toBe(true));
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
});
