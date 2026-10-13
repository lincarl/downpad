// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import type { FilePayload } from "../ipc/contracts";
import { blankDoc } from "../state/types";
import { FileService } from "./FileService";

const native = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<FilePayload>>(),
  ask: vi.fn<(message: string) => Promise<boolean>>(),
}));

vi.mock("../ipc/commands", () => ({ readFile: native.readFile }));
vi.mock("../ipc/dialogs", () => ({ ask: native.ask }));

const filePath = "/docs/notes.md";
const onDisk: FilePayload = {
  content: "# Changed outside the app\n",
  eol: "crlf",
  hadBom: false,
  modifiedMs: 200,
  sizeBytes: 28,
};

function setup(dirty = false) {
  const store = createAppStore();
  store.addTab({
    ...blankDoc(),
    markdown: "# Original content\n",
    filePath,
    modifiedMs: 100,
    isDirty: dirty,
    frontmatterCollapsed: true,
  });
  const presenter = {
    flush: vi.fn(),
    showActiveDoc: vi.fn(async () => {}),
    reloadActiveDoc: vi.fn(async () => {}),
  };
  return { store, presenter, files: new FileService(store, presenter) };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.readFile.mockResolvedValue(onDisk);
  native.ask.mockResolvedValue(true);
});

describe("reloading an open file", () => {
  it("rereads disk into the same tab and keeps other tabs", async () => {
    const { store, presenter, files } = setup();
    const tabId = store.get().activeTabId;
    const tabs = store.get().tabs.map((tab) => tab.id);

    await files.openPath(filePath, { reload: true });

    expect(native.readFile).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(store.get().activeTabId).toBe(tabId);
    expect(store.get().tabs.map((tab) => tab.id)).toEqual(tabs);
    expect(store.get().doc).toMatchObject({
      markdown: onDisk.content,
      eol: "crlf",
      modifiedMs: 200,
      isDirty: false,
      frontmatterCollapsed: true,
    });
    expect(presenter.reloadActiveDoc).toHaveBeenCalledOnce();
    expect(native.ask).not.toHaveBeenCalled();
  });

  it("preserves unsaved content when the user cancels reload", async () => {
    const { store, presenter, files } = setup(true);
    native.ask.mockResolvedValueOnce(false);
    const before = store.get().doc;

    await files.openPath(filePath, { reload: true });

    expect(native.ask).toHaveBeenCalledOnce();
    expect(native.readFile).not.toHaveBeenCalled();
    expect(store.get().doc).toEqual(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("keeps the current document when reading the changed file fails", async () => {
    const { store, presenter, files } = setup();
    const before = store.get().doc;
    native.readFile.mockRejectedValueOnce(new Error("File is unavailable"));

    await expect(files.openPath(filePath, { reload: true })).rejects.toThrow("File is unavailable");

    expect(store.get().doc).toEqual(before);
    expect(presenter.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("normal Open focuses an existing dirty tab without rereading it", async () => {
    const { store, presenter, files } = setup(true);
    const before = store.get().doc;

    await files.openPath(filePath);

    expect(store.get().doc).toEqual(before);
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.ask).not.toHaveBeenCalled();
    expect(presenter.showActiveDoc).toHaveBeenCalledOnce();
  });
});
