// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronBridge } from "./bridge";
import { readFile, searchRecentContents } from "./commands";
import { ask, openDialog, saveDialog } from "./dialogs";
import { isElectron } from "./env";

function createTestBridge() {
  return {
    platform: "linux",
    invoke: vi.fn<ElectronBridge["invoke"]>(),
    listen: vi.fn<ElectronBridge["listen"]>(() => () => {}),
    openDialog: vi.fn<ElectronBridge["openDialog"]>(async () => null),
    saveDialog: vi.fn<ElectronBridge["saveDialog"]>(async () => null),
    ask: vi.fn<ElectronBridge["ask"]>(async () => false),
    openExternal: async () => {},
    revealItemInFolder: async () => {},
    setTheme: async () => {},
    getPathForFile: () => "",
    convertFileSrc: async (path: string) => path,
    closeWindow: async () => {},
    cancelWindowClose: async () => {},
  };
}

describe("Electron preload integration", () => {
  let bridge: ReturnType<typeof createTestBridge>;

  beforeEach(() => {
    bridge = createTestBridge();
    // Vitest widens a generic command mock's return to the union of payloads.
    window.downpad = bridge as ElectronBridge;
  });

  afterEach(() => {
    delete window.downpad;
    vi.restoreAllMocks();
  });

  it("reads a document through the isolated typed command bridge", async () => {
    const payload = {
      content: "# Notes\n",
      eol: "lf" as const,
      hadBom: false,
      sizeBytes: 8,
      modifiedMs: 100,
    };
    bridge.invoke.mockResolvedValueOnce(payload);

    expect(isElectron()).toBe(true);
    await expect(readFile("/docs/notes.md")).resolves.toEqual(payload);
    expect(bridge.invoke).toHaveBeenCalledWith("read_file", { path: "/docs/notes.md" });
  });

  it("keeps browser dialogs usable and rejects filesystem commands without preload", async () => {
    delete window.downpad;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);

    expect(isElectron()).toBe(false);
    await expect(openDialog({ multiple: false })).resolves.toBeNull();
    await expect(saveDialog({ defaultPath: "notes.md" })).resolves.toBeNull();
    await expect(ask("Discard changes?")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard changes?");
    await expect(readFile("/docs/notes.md")).rejects.toThrow("installed Downpad app");
  });

  it("subscribes before starting content search and ignores another search's results", async () => {
    const unlisten = vi.fn();
    bridge.listen.mockReturnValueOnce(unlisten);
    let finish!: (value: { scanned: number; matched: number; cancelled: boolean }) => void;
    bridge.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const onResult = vi.fn();
    const result = searchRecentContents("active-search", "needle", { caseSensitive: false }, onResult);

    expect(bridge.listen).toHaveBeenCalledWith("search-result", expect.any(Function));
    expect(bridge.listen.mock.invocationCallOrder[0]).toBeLessThan(bridge.invoke.mock.invocationCallOrder[0]!);
    const listener = bridge.listen.mock.calls[0]![1];
    const hit = { kind: "content" as const, path: "/docs/notes.md", line: 2, snippet: "needle", scanned: 1, matched: 1 };
    listener({ searchId: "old-search", hit });
    expect(onResult).not.toHaveBeenCalled();
    listener({ searchId: "active-search", hit });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(hit);

    const summary = { scanned: 1, matched: 1, cancelled: false };
    finish(summary);
    await expect(result).resolves.toEqual(summary);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(bridge.invoke).toHaveBeenCalledWith("search_recent_contents", {
      searchId: "active-search",
      query: "needle",
      opts: { caseSensitive: false },
    });
  });

  it("waits for result events that arrive after the search's reply", async () => {
    const unlisten = vi.fn();
    bridge.listen.mockReturnValueOnce(unlisten);
    let finish!: (value: { scanned: number; matched: number; cancelled: boolean }) => void;
    bridge.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const onResult = vi.fn();
    let settled = false;
    const result = searchRecentContents("late", "needle", { caseSensitive: false }, onResult).then((summary) => {
      settled = true;
      return summary;
    });
    const listener = bridge.listen.mock.calls[0]![1];
    const hit = (path: string, matched: number) => ({
      searchId: "late",
      hit: { kind: "content" as const, path, line: 1, snippet: "needle", scanned: matched, matched },
    });

    listener(hit("/docs/a.md", 1));
    finish({ scanned: 2, matched: 2, cancelled: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(unlisten).not.toHaveBeenCalled();

    listener(hit("/docs/b.md", 2));
    await expect(result).resolves.toEqual({ scanned: 2, matched: 2, cancelled: false });
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("stops waiting for missing result events after a short grace period", async () => {
    vi.useFakeTimers();
    try {
      bridge.invoke.mockResolvedValueOnce({ scanned: 3, matched: 1, cancelled: false });
      const result = searchRecentContents("lost", "needle", { caseSensitive: false }, vi.fn());
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toEqual({ scanned: 3, matched: 1, cancelled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases content-search listeners when the native command fails", async () => {
    const unlisten = vi.fn();
    bridge.listen.mockReturnValueOnce(unlisten);
    bridge.invoke.mockRejectedValueOnce(new Error("Search failed"));

    await expect(searchRecentContents("failed", "needle", { caseSensitive: false }, vi.fn()))
      .rejects.toThrow("Search failed");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
