import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { FileService } from "../files/FileService";
import { blankDoc, type DocumentState, type Settings } from "../state/types";
import { SnapshotScheduler } from "./snapshotScheduler";
import type { Snapshot } from "../ipc/contracts";

const native = vi.hoisted(() => ({
  writeFile: vi.fn(async () => ({ modifiedMs: 200 })),
  writeSnapshot: vi.fn<typeof import("../ipc/commands").writeSnapshot>(async () => {}),
  deleteSnapshot: vi.fn<typeof import("../ipc/commands").deleteSnapshot>(async () => {}),
}));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", () => ({
  writeFile: native.writeFile,
  writeSnapshot: native.writeSnapshot,
  deleteSnapshot: native.deleteSnapshot,
}));

const schedulers: SnapshotScheduler[] = [];
const snapshots = new Map<string, Snapshot>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  vi.resetAllMocks();
  snapshots.clear();
  native.writeSnapshot.mockImplementation(async (snapshot) => { snapshots.set(snapshot.sessionId, snapshot); });
  native.deleteSnapshot.mockImplementation(async (id) => { snapshots.delete(id); });
});

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Start both timers with one document and real file-service behavior. */
function scheduledDocument(doc: Partial<DocumentState> = {}, settings: Partial<Settings> = {}) {
  const store = createAppStore();
  store.set((state) => ({ settings: {
    ...state.settings,
    recoverySnapshotIntervalSeconds: 2,
    autosaveIntervalSeconds: 5,
    autosaveEnabled: false,
    ...settings,
  } }));
  store.replaceActiveDoc({ ...blankDoc(), markdown: "# Draft\n", filePath: "/docs/notes.md", isDirty: true, ...doc });
  const presenter = { flush: vi.fn(), showActiveDoc: vi.fn(async () => {}), reloadActiveDoc: vi.fn(async () => {}) };
  const files = new FileService(store, presenter);
  const scheduler = new SnapshotScheduler(store, files);
  schedulers.push(scheduler);
  scheduler.start();
  return { store, presenter, files, scheduler };
}

/** Hold a native operation until its completion is explicitly released. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("keeps a dirty background tab's recovery when the active tab is clean", async () => {
  const { store } = scheduledDocument();
  const dirtyTab = store.get().activeTabId!;
  await vi.advanceTimersByTimeAsync(2_000);
  const [original] = [...snapshots.values()];
  expect(original?.markdown).toBe("# Draft\n");

  store.addTab(blankDoc());
  await vi.advanceTimersByTimeAsync(2_000);
  expect(store.get().tabs.find((tab) => tab.id === dirtyTab)?.doc.isDirty).toBe(true);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
  expect([...snapshots.values()]).toEqual([expect.objectContaining({ markdown: "# Draft\n" })]);
});

it("keeps independent recovery for every dirty tab, including untitled tabs and background edits", async () => {
  const { store } = scheduledDocument({ filePath: null });
  const first = store.get().activeTabId!;
  const second = store.addTab({ ...blankDoc(), markdown: "# Second\n", isDirty: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect([...snapshots.values()].map((snapshot) => snapshot.markdown).sort()).toEqual(["# Draft\n", "# Second\n"]);
  const ids = [...snapshots.keys()].sort();
  expect(ids).toEqual([first, second].sort());

  store.addTab(blankDoc());
  store.patchDocById(first, { markdown: "# Latest background edit\n" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect([...snapshots.keys()].sort()).toEqual(ids);
  expect(snapshots.get(first)?.markdown).toBe("# Latest background edit\n");
  expect(snapshots.get(second)?.markdown).toBe("# Second\n");
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

it("cleans up only saved or discarded tabs and retries a failed deletion", async () => {
  const { store, files } = scheduledDocument();
  const saved = store.get().activeTabId!;
  const discarded = store.addTab({ ...blankDoc(), markdown: "Discard me", isDirty: true });
  const surviving = store.addTab({ ...blankDoc(), markdown: "Keep me", isDirty: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.size).toBe(3);

  store.activateTab(saved);
  await files.save();
  store.closeTab(discarded);
  store.activateTab(surviving);
  native.deleteSnapshot.mockRejectedValueOnce(new Error("Disk busy"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.has(saved)).toBe(true);
  expect(snapshots.has(discarded)).toBe(false);
  expect(snapshots.get(surviving)?.markdown).toBe("Keep me");
  await vi.advanceTimersByTimeAsync(2_000);
  expect([...snapshots.keys()]).toEqual([surviving]);
  expect(native.deleteSnapshot.mock.calls.filter(([id]) => id === saved)).toHaveLength(2);
  expect(native.deleteSnapshot).not.toHaveBeenCalledWith(surviving);
});

it("does not overlap writes for one tab while other tabs keep their recovery", async () => {
  const writing = deferred();
  native.writeSnapshot.mockImplementationOnce(async (snapshot) => {
    await writing.promise;
    snapshots.set(snapshot.sessionId, snapshot);
  });
  const { store } = scheduledDocument();
  const first = store.get().activeTabId!;
  await vi.advanceTimersByTimeAsync(2_000);
  store.patchDoc({ markdown: "# Newer edits\n" });
  const second = store.addTab({ ...blankDoc(), markdown: "# Second\n", isDirty: true });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(native.writeSnapshot.mock.calls.filter(([snapshot]) => snapshot.markdown !== "# Second\n")).toHaveLength(1);
  expect(snapshots.get(second)?.markdown).toBe("# Second\n");

  writing.resolve();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.get(first)?.markdown).toBe("# Newer edits\n");
  expect(snapshots.get(second)?.markdown).toBe("# Second\n");
});

it("waits for pending writes before clearing every owned snapshot and stops further writes", async () => {
  const writing = deferred();
  native.writeSnapshot.mockImplementationOnce(async (snapshot) => {
    await writing.promise;
    snapshots.set(snapshot.sessionId, snapshot);
  });
  const { store, scheduler } = scheduledDocument();
  store.addTab({ ...blankDoc(), markdown: "# Second\n", isDirty: true });
  await vi.advanceTimersByTimeAsync(2_000);
  let cleared = false;
  const clearing = scheduler.clear().then(() => { cleared = true; });
  const alsoClearing = scheduler.clear();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(cleared).toBe(false);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);

  writing.resolve();
  await clearing;
  await alsoClearing;
  expect(snapshots.size).toBe(0);
  expect(native.deleteSnapshot).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
});

it("retains failed shutdown cleanup for a retry and resumes recovery when close fails", async () => {
  const { store, scheduler } = scheduledDocument();
  await vi.advanceTimersByTimeAsync(2_000);
  native.deleteSnapshot.mockRejectedValueOnce(new Error("Disk busy"));
  await expect(scheduler.clear()).rejects.toThrow("Disk busy");
  expect(snapshots.size).toBe(1);

  store.patchDoc({ markdown: "# After cancelled close\n" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect([...snapshots.values()][0]?.markdown).toBe("# After cancelled close\n");
  await scheduler.clear();
  expect(snapshots.size).toBe(0);
});

it("does not restart after an explicit stop during failed shutdown cleanup", async () => {
  const deleting = deferred();
  native.deleteSnapshot.mockImplementationOnce(async () => {
    await deleting.promise;
    throw new Error("Disk busy");
  });
  const { scheduler } = scheduledDocument();
  await vi.advanceTimersByTimeAsync(2_000);
  const failure = expect(scheduler.clear()).rejects.toThrow("Disk busy");
  scheduler.stop();
  deleting.resolve();
  await failure;
  expect(vi.getTimerCount()).toBe(0);
  expect(snapshots.size).toBe(1);
  await scheduler.clear();
  expect(snapshots.size).toBe(0);
});

it("remembers a first write that reports failure after persisting, even if its tab closes", async () => {
  native.writeSnapshot.mockImplementationOnce(async (snapshot) => {
    snapshots.set(snapshot.sessionId, snapshot);
    throw new Error("Write completion failed");
  });
  const { store } = scheduledDocument();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.size).toBe(1);
  store.closeTab(store.get().activeTabId!);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.size).toBe(0);
});

it("waits for pending cleanup before snapshotting new edits under the same tab ID", async () => {
  const deleting = deferred();
  const { store } = scheduledDocument();
  const id = store.get().activeTabId!;
  await vi.advanceTimersByTimeAsync(2_000);
  native.deleteSnapshot.mockImplementationOnce(async (id) => {
    await deleting.promise;
    snapshots.delete(id);
  });
  store.patchDoc({ isDirty: false });
  await vi.advanceTimersByTimeAsync(2_000);
  store.patchDoc({ filePath: "/docs/renamed.md", markdown: "# Edited after save\n", isDirty: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(1);
  deleting.resolve();
  await vi.advanceTimersByTimeAsync(2_000);
  expect([...snapshots.values()]).toEqual([expect.objectContaining({
    sessionId: id, filePath: "/docs/renamed.md", markdown: "# Edited after save\n",
  })]);
});

it("starts timers once and keeps late write ownership across stop and restart", async () => {
  const writing = deferred();
  native.writeSnapshot.mockImplementationOnce(async (snapshot) => {
    await writing.promise;
    snapshots.set(snapshot.sessionId, snapshot);
  });
  const { store, scheduler } = scheduledDocument();
  scheduler.start();
  expect(vi.getTimerCount()).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  scheduler.stop();
  store.closeTab(store.get().activeTabId!);
  writing.resolve();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(snapshots.size).toBe(1);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();

  scheduler.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(snapshots.size).toBe(0);
});

it("snapshots current untitled edits while dirty and deletes once when the document becomes clean", async () => {
  const { store } = scheduledDocument({ filePath: null, isDirty: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).not.toHaveBeenCalled();
  expect(native.deleteSnapshot).not.toHaveBeenCalled();

  store.patchDoc({ isDirty: true });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(native.writeSnapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(native.writeSnapshot).toHaveBeenCalledExactlyOnceWith({
    sessionId: store.get().activeTabId!,
    savedAt: "2026-10-22T12:00:04.000Z",
    filePath: null,
    markdown: "# Draft\n",
    isDirty: true,
  });

  store.patchDoc({ markdown: "# Latest edit\n" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).toHaveBeenLastCalledWith({
    sessionId: store.get().activeTabId!,
    savedAt: "2026-10-22T12:00:06.000Z",
    filePath: null,
    markdown: "# Latest edit\n",
    isDirty: true,
  });
  expect(native.deleteSnapshot).not.toHaveBeenCalled();

  store.patchDoc({ isDirty: false });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(store.get().activeTabId!);
  expect(native.writeFile).not.toHaveBeenCalled();
});

it("retries a failed snapshot write on the next interval with the latest edits", async () => {
  native.writeSnapshot.mockRejectedValueOnce(new Error("Disk temporarily unavailable"));
  const { store } = scheduledDocument();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(1);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();

  store.patchDoc({ markdown: "# Edited after failure\n" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  expect(native.writeSnapshot).toHaveBeenLastCalledWith({
    sessionId: store.get().activeTabId!,
    savedAt: "2026-10-22T12:00:04.000Z",
    filePath: "/docs/notes.md",
    markdown: "# Edited after failure\n",
    isDirty: true,
  });

  store.patchDoc({ isDirty: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(store.get().activeTabId!);
});

it.each([
  { name: "disabled", enabled: false, dirty: true, path: "/docs/notes.md", saves: false },
  { name: "clean", enabled: true, dirty: false, path: "/docs/notes.md", saves: false },
  { name: "untitled", enabled: true, dirty: true, path: null, saves: false },
  { name: "enabled, dirty, and named", enabled: true, dirty: true, path: "/docs/notes.md", saves: true },
])("checks current autosave eligibility for a $name document", async ({ enabled, dirty, path, saves }) => {
  const { store, files } = scheduledDocument();
  const saving = vi.spyOn(files, "save");
  store.set((state) => ({ settings: { ...state.settings, autosaveEnabled: enabled } }));
  store.patchDoc({ isDirty: dirty, filePath: path });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(saving).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(saving.mock.calls).toEqual(saves ? [[{ keepTypedMark: true }]] : []);
  expect(native.writeFile.mock.calls).toEqual(saves ? [["/docs/notes.md", "# Draft\n", "lf"]] : []);
});

it("stops both timers without deleting the recovery snapshot", async () => {
  const { store, scheduler } = scheduledDocument({}, { autosaveEnabled: true });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  expect(native.writeFile).toHaveBeenCalledTimes(1);

  store.patchDoc({ isDirty: true, markdown: "# Edited after stop\n" });
  scheduler.stop();
  scheduler.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  expect(native.writeFile).toHaveBeenCalledTimes(1);
  expect(native.deleteSnapshot).not.toHaveBeenCalled();
});

it("autosaves with a typed closing mark kept waiting, while Save decides it", async () => {
  const { presenter, files, scheduler } = scheduledDocument({ markdown: "Cost $5-$\n" }, { autosaveEnabled: true });

  // A pause in typing must not turn "5-" into a formula.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(native.writeFile).toHaveBeenCalledWith("/docs/notes.md", "Cost $5-$\n", "lf");
  expect(presenter.flush).toHaveBeenLastCalledWith({ keepTypedMark: true });
  scheduler.stop();

  await files.save();
  expect(presenter.flush).toHaveBeenLastCalledWith({});
});
