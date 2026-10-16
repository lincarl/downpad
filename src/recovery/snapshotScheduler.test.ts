import { afterEach, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { FileService } from "../files/FileService";
import { blankDoc } from "../state/types";
import { SnapshotScheduler } from "./snapshotScheduler";

const native = vi.hoisted(() => ({ writeFile: vi.fn(async () => ({ modifiedMs: 200 })) }));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", () => ({
  writeFile: native.writeFile,
  writeSnapshot: vi.fn(async () => {}),
  deleteSnapshot: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.useRealTimers();
});

it("autosaves with a typed closing mark kept waiting, while Save decides it", async () => {
  vi.useFakeTimers();
  const store = createAppStore();
  store.set((state) => ({ settings: { ...state.settings, autosaveEnabled: true, autosaveIntervalSeconds: 5 } }));
  store.addTab({ ...blankDoc(), markdown: "Cost $5-$\n", filePath: "/docs/notes.md", isDirty: true });
  const presenter = { flush: vi.fn(), showActiveDoc: vi.fn(async () => {}), reloadActiveDoc: vi.fn(async () => {}) };
  const files = new FileService(store, presenter);
  const scheduler = new SnapshotScheduler(store, files);
  scheduler.start();

  // A pause in typing must not turn "5-" into a formula.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(native.writeFile).toHaveBeenCalledWith("/docs/notes.md", "Cost $5-$\n", "lf");
  expect(presenter.flush).toHaveBeenLastCalledWith({ keepTypedMark: true });
  scheduler.stop();

  await files.save();
  expect(presenter.flush).toHaveBeenLastCalledWith({});
});
