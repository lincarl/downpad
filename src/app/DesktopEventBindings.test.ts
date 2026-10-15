// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { ElectronBridge } from "../ipc/bridge";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import { createAppStore } from "./createAppStore";
import { DesktopEventBindings } from "./DesktopEventBindings";

const events = vi.hoisted(() => ({ closeRequested: null as (() => void) | null }));

vi.mock("../ipc/events", () => ({
  onFileChanged: async () => () => {},
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
      commitPendingEdits: () => {},
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
