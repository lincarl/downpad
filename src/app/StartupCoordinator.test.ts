// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEditorMarkdownForTab } from "../document/DocumentModel";
import { EditorHost } from "../editor/EditorHost";
import { FileService } from "../files/FileService";
import type { Snapshot } from "../ipc/contracts";
import type { RecoveryHandlers } from "../recovery/RecoveryDialog";
import { SettingsModel } from "../settings/SettingsModel";
import { createAppStore } from "./createAppStore";
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
}));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listRecoverySnapshots: native.listRecoverySnapshots,
  deleteSnapshot: native.deleteSnapshot,
}));
// The user picks "Open recovered" for the first snapshot.
vi.mock("../recovery/RecoveryDialog", () => ({
  RecoveryDialog: class {
    /** Open the first snapshot as recovered text. */
    async open(snapshots: Snapshot[], handlers: RecoveryHandlers): Promise<void> {
      await handlers.openRecovered(snapshots[0]!);
    }
    /** Nothing to close. */
    destroy(): void {}
  },
}));

let host: EditorHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
  vi.restoreAllMocks();
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
