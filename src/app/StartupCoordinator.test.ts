// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEditorMarkdownForTab } from "../document/DocumentModel";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { FilePayload, Session, Snapshot } from "../ipc/contracts";
import type { RecoveryHandlers } from "../recovery/RecoveryDialog";
import { SettingsModel } from "../settings/SettingsModel";
import { createAppStore } from "./createAppStore";
import { SessionKeeper } from "./SessionKeeper";
import { StartupCoordinator } from "./StartupCoordinator";

const snapshot: Snapshot = {
  sessionId: "earlier-session",
  savedAt: "2026-10-15T12:00:00.000Z",
  filePath: "/docs/notes.md",
  markdown: "# Notes\n\nRecovered edits.\n",
  isDirty: true,
};

const native = vi.hoisted(() => ({
  listRecoverySnapshots: vi.fn<() => Promise<Snapshot[]>>(),
  deleteSnapshot: vi.fn<(sessionId: string) => Promise<void>>(),
  readFile: vi.fn<typeof import("../ipc/commands").readFile>(),
  recordFileOpened: vi.fn(async () => {}),
  getLaunchArgs: vi.fn<() => Promise<string | null>>(async () => null),
  loadSession: vi.fn<() => Promise<Session>>(),
  saveSession: vi.fn<(session: Session) => Promise<void>>(),
}));
const recovery = vi.hoisted(() => ({
  open: vi.fn<(snapshots: Snapshot[], handlers: RecoveryHandlers) => Promise<void>>(),
}));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listRecoverySnapshots: native.listRecoverySnapshots,
  deleteSnapshot: native.deleteSnapshot,
  readFile: native.readFile,
  recordFileOpened: native.recordFileOpened,
  getLaunchArgs: native.getLaunchArgs,
  loadSession: native.loadSession,
  saveSession: native.saveSession,
}));
vi.mock("../recovery/RecoveryDialog", () => ({
  RecoveryDialog: class {
    open = recovery.open;
    /** Nothing to close. */
    destroy(): void {}
  },
}));

let host: EditorHost | null = null;
beforeEach(() => {
  vi.resetAllMocks();
  native.listRecoverySnapshots.mockResolvedValue([snapshot]);
  native.deleteSnapshot.mockResolvedValue();
  native.loadSession.mockResolvedValue({ files: [], active: null });
  recovery.open.mockImplementation(async (snapshots, handlers) => { await handlers.openRecovered(snapshots[0]!); });
});
afterEach(async () => {
  await host?.dispose();
  host = null;
  vi.restoreAllMocks();
});

/** Exercise startup with real file-service reads and a controlled dialog choice. */
function setup() {
  const store = createAppStore();
  store.set((state) => ({ settings: { ...state.settings, hasSeenWelcome: true } }));
  const presenter = {
    flush: () => {},
    showActiveDoc: async () => {},
    reloadActiveDoc: vi.fn(async () => {}),
  };
  const files = new FileService(store, presenter);
  vi.spyOn(files, "watch").mockImplementation(() => {});
  host = new EditorHost(document.createElement("div"), store);
  const lifecycle = { disposed: false };
  const startup = new StartupCoordinator({
    store, files, editorHost: host,
    settings: new SettingsModel(store, () => {}),
    isDisposed: () => lifecycle.disposed,
  });
  return { store, startup, lifecycle, presenter };
}

it("keeps recovery and reports failed original opens without claiming startup loaded a document", async () => {
  const { store, startup } = setup();
  native.readFile.mockRejectedValue(new Error("Original file is missing"));
  let failure: unknown;
  recovery.open.mockImplementation(async (snapshots, handlers) => {
    try { await handlers.openOriginal(snapshots[0]!); } catch (error) { failure = error; }
    // The user closes the recovery dialog after seeing the error.
  });

  expect(await startup.resolve()).toBe(false);
  expect(native.readFile).toHaveBeenCalledWith(snapshot.filePath);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
  expect(failure).toEqual(new Error("Original file is missing"));
  expect(store.get().tabs).toHaveLength(0);
});

it("can open the recovered text after an original open fails", async () => {
  const { store, startup } = setup();
  native.readFile.mockRejectedValue(new Error("Original file is missing"));
  recovery.open.mockImplementation(async (snapshots, handlers) => {
    const offered = snapshots[0]!;
    await expect(handlers.openOriginal(offered)).rejects.toThrow("Original file is missing");
    expect(native.deleteSnapshot).not.toHaveBeenCalled();
    await handlers.openRecovered(offered);
  });

  expect(await startup.resolve()).toBe(true);
  expect(store.get().doc).toMatchObject({ markdown: snapshot.markdown, isDirty: true });
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot.sessionId);
});

it("deletes recovery only after the original file has opened successfully", async () => {
  const { store, startup } = setup();
  let finishRead!: (value: Awaited<ReturnType<typeof native.readFile>>) => void;
  native.readFile.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
  recovery.open.mockImplementation(async (snapshots, handlers) => { await handlers.openOriginal(snapshots[0]!); });
  const resolving = startup.resolve();
  await vi.waitFor(() => expect(native.readFile).toHaveBeenCalledOnce());
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
  finishRead({ content: "# Original\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 11 });
  expect(await resolving).toBe(true);
  expect(store.get().doc).toMatchObject({ markdown: "# Original\n", isDirty: false });
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot.sessionId);
});

it("preserves recovery when disposal interrupts an original open", async () => {
  const { startup, lifecycle } = setup();
  native.readFile.mockImplementation(async () => {
    lifecycle.disposed = true;
    return { content: "# Original\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 11 };
  });
  recovery.open.mockImplementation(async (snapshots, handlers) => { await handlers.openOriginal(snapshots[0]!); });
  expect(await startup.resolve()).toBe(false);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

it("does not count a recovered open after disposal as successful", async () => {
  const { startup, lifecycle } = setup();
  recovery.open.mockImplementation(async (snapshots, handlers) => {
    lifecycle.disposed = true;
    await handlers.openRecovered(snapshots[0]!);
  });
  expect(await startup.resolve()).toBe(false);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

it("keeps recovery when the original file was read but could not be shown", async () => {
  const { startup, presenter } = setup();
  native.readFile.mockResolvedValue({ content: "# Original\n", eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: 11 });
  presenter.reloadActiveDoc.mockRejectedValue(new Error("Editor unavailable"));
  recovery.open.mockImplementation(async (snapshots, handlers) => {
    await expect(handlers.openOriginal(snapshots[0]!)).rejects.toThrow("Editor unavailable");
  });
  expect(await startup.resolve()).toBe(false);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

it("does not delete an untitled recovery entry or count it as an opened original", async () => {
  const { startup } = setup();
  native.listRecoverySnapshots.mockResolvedValue([{ ...snapshot, filePath: null }]);
  recovery.open.mockImplementation(async (snapshots, handlers) => {
    expect(await handlers.openOriginal(snapshots[0]!)).toBe(false);
  });
  expect(await startup.resolve()).toBe(false);
  expect(native.readFile).not.toHaveBeenCalled();
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

describe("opening a recovered snapshot", () => {
  it("keeps it unsaved after an edit and its undo", async () => {
    native.listRecoverySnapshots.mockResolvedValue([snapshot]);
    native.deleteSnapshot.mockResolvedValue();
    const store = createAppStore();
    const files = new FileService(store, {
      flush: () => {},
      showActiveDoc: async () => {},
      reloadActiveDoc: async () => {},
    });
    vi.spyOn(files, "watch").mockImplementation(() => {});
    host = new EditorHost(document.createElement("div"), store);
    const startup = new StartupCoordinator({
      store,
      files,
      editorHost: host,
      settings: new SettingsModel(store, () => {}),
      isDisposed: () => false,
    });

    expect(await startup.resolve()).toBe(true);
    // The file may have changed since the snapshot, so its text is unknown.
    expect(store.get().doc).toMatchObject({ markdown: snapshot.markdown, savedMarkdown: null, isDirty: true });
    const tabId = store.get().activeTabId!;
    applyEditorMarkdownForTab(store, tabId, "# Notes\n\nRecovered edits. More.\n");
    applyEditorMarkdownForTab(store, tabId, snapshot.markdown);
    expect(store.get().doc.isDirty).toBe(true);
    expect(native.deleteSnapshot).toHaveBeenCalledWith(snapshot.sessionId);
  });
});

describe("reopening the documents open at the last close", () => {
  const onDisk: Record<string, string> = {
    "/docs/a.md": "# A\n",
    "/docs/b.md": "# B\n",
    "/docs/c.md": "# C\n",
    "/docs/notes.md": "# Notes\n\nSaved text.\n",
  };
  const payload = (content: string): FilePayload => ({ content, eol: "lf", hadBom: false, modifiedMs: 100, sizeBytes: content.length });
  const tabFiles = (store: ReturnType<typeof setup>["store"]) => store.get().tabs.map((tab) => tab.doc.filePath);
  const activeFile = (store: ReturnType<typeof setup>["store"]) =>
    store.get().tabs.find((tab) => tab.id === store.get().activeTabId)?.doc.filePath;

  beforeEach(() => {
    native.listRecoverySnapshots.mockResolvedValue([]);
    native.readFile.mockImplementation(async (path) => {
      const content = onDisk[path];
      if (content === undefined) throw new Error("The file is missing.");
      return payload(content);
    });
  });

  it("reopens readable files in order with the same active one and remembers unavailable paths", async () => {
    const { store, startup, presenter } = setup();
    native.loadSession.mockResolvedValue({ files: ["/docs/a.md", "/docs/gone.md", "/docs/b.md", "/docs/c.md"], active: "/docs/b.md" });

    expect(await startup.resolve()).toBe(true);
    expect(tabFiles(store)).toEqual(["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    expect(activeFile(store)).toBe("/docs/b.md");
    expect(store.get().doc).toMatchObject({ filePath: "/docs/b.md", markdown: "# B\n", isDirty: false, savedMarkdown: "# B\n" });
    // Reopening is not opening the files again, and AppRuntime shows the active tab.
    expect(native.recordFileOpened).not.toHaveBeenCalled();
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
    expect(native.getLaunchArgs).toHaveBeenCalledOnce();
    const keeper = new SessionKeeper(store);
    keeper.start(startup.sessionToRestore);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({
      files: ["/docs/a.md", "/docs/gone.md", "/docs/b.md", "/docs/c.md"], active: "/docs/b.md",
    });
    keeper.dispose();
  });

  it("opens the launch file beside them as the active tab, or switches to it when it is one of them", async () => {
    const first = setup();
    native.loadSession.mockResolvedValue({ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/a.md" });
    native.getLaunchArgs.mockResolvedValueOnce("/docs/c.md");
    expect(await first.startup.resolve()).toBe(true);
    expect(tabFiles(first.store)).toEqual(["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    expect(activeFile(first.store)).toBe("/docs/c.md");

    const second = setup();
    native.getLaunchArgs.mockResolvedValueOnce("/docs/b.md");
    expect(await second.startup.resolve()).toBe(true);
    expect(tabFiles(second.store)).toEqual(["/docs/a.md", "/docs/b.md"]);
    expect(activeFile(second.store)).toBe("/docs/b.md");
  });

  it("keeps recovered work instead of reopening its file from disk", async () => {
    const { store, startup } = setup();
    native.listRecoverySnapshots.mockResolvedValue([snapshot]);
    native.loadSession.mockResolvedValue({ files: ["/docs/a.md", snapshot.filePath!], active: snapshot.filePath });

    expect(await startup.resolve()).toBe(true);
    expect(tabFiles(store)).toEqual([snapshot.filePath, "/docs/a.md"]);
    expect(store.get().doc).toMatchObject({ filePath: snapshot.filePath, markdown: snapshot.markdown, isDirty: true });
    expect(native.readFile).not.toHaveBeenCalledWith(snapshot.filePath);
  });

  it("starts on the Recent view when none of the files can be read", async () => {
    const { store, startup } = setup();
    native.loadSession.mockResolvedValue({ files: ["/docs/gone.md"], active: "/docs/gone.md" });
    expect(await startup.resolve()).toBe(false);
    expect(store.get().tabs).toEqual([]);
  });

  it("keeps recovered work active instead of an unavailable previous active file", async () => {
    const { store, startup } = setup();
    native.listRecoverySnapshots.mockResolvedValue([snapshot]);
    native.loadSession.mockResolvedValue({ files: ["/offline/notes.md"], active: "/offline/notes.md" });
    expect(await startup.resolve()).toBe(true);
    const keeper = new SessionKeeper(store);
    keeper.start(startup.sessionToRestore);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/offline/notes.md", snapshot.filePath], active: snapshot.filePath });
    keeper.dispose();
  });

  it.each([{ available: [] }, { available: ["/docs/a.md", "/docs/b.md"] }])("retries unavailable files across restarts with readable files $available", async ({ available }) => {
    const unavailable = "/offline/notes.md";
    const previous: Session = { files: [...available.slice(0, 1), unavailable, ...available.slice(1)], active: unavailable };
    let recorded = previous;
    native.loadSession.mockImplementation(async () => recorded);
    native.saveSession.mockImplementation(async (session) => { recorded = session; });

    for (let restart = 0; restart < 2; restart++) {
      const { store, startup } = setup();
      expect(await startup.resolve()).toBe(available.length > 0);
      expect(tabFiles(store)).toEqual(available);
      const keeper = new SessionKeeper(store);
      keeper.start(startup.sessionToRestore);
      await keeper.flush();
      expect(recorded).toEqual(previous);
      keeper.dispose();
      await host?.dispose();
      host = null;
    }

    native.readFile.mockImplementation(async (path) => payload(path === unavailable ? "# Available again\n" : onDisk[path]!));
    const { store, startup } = setup();
    expect(await startup.resolve()).toBe(true);
    expect(tabFiles(store)).toEqual(previous.files);
    expect(activeFile(store)).toBe(unavailable);
    expect(store.get().doc.markdown).toBe("# Available again\n");
  });

  it("remembers an explicit launch file as active while retaining an unavailable previous file", async () => {
    const { store, startup } = setup();
    native.loadSession.mockResolvedValue({ files: ["/offline/notes.md"], active: "/offline/notes.md" });
    native.getLaunchArgs.mockResolvedValue("/docs/a.md");
    expect(await startup.resolve()).toBe(true);
    const keeper = new SessionKeeper(store);
    keeper.start(startup.sessionToRestore);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/offline/notes.md", "/docs/a.md"], active: "/docs/a.md" });
    keeper.dispose();
  });
});
