import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { FileService } from "../files/FileService";
import { blankDoc, type DocumentState, type Settings } from "../state/types";
import { SnapshotScheduler } from "./snapshotScheduler";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  vi.resetAllMocks();
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
    sessionId: store.get().sessionId,
    savedAt: "2026-10-22T12:00:04.000Z",
    filePath: null,
    markdown: "# Draft\n",
    isDirty: true,
  });

  store.patchDoc({ markdown: "# Latest edit\n" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.writeSnapshot).toHaveBeenLastCalledWith({
    sessionId: store.get().sessionId,
    savedAt: "2026-10-22T12:00:06.000Z",
    filePath: null,
    markdown: "# Latest edit\n",
    isDirty: true,
  });
  expect(native.deleteSnapshot).not.toHaveBeenCalled();

  store.patchDoc({ isDirty: false });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(store.get().sessionId);
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
    sessionId: store.get().sessionId,
    savedAt: "2026-10-22T12:00:04.000Z",
    filePath: "/docs/notes.md",
    markdown: "# Edited after failure\n",
    isDirty: true,
  });

  store.patchDoc({ isDirty: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(store.get().sessionId);
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
