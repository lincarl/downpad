import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DropPoint, FileDrop } from "../editor/EditorHost";
import type { ImageBytes } from "../ipc/contracts";
import { blankDoc } from "../state/types";
import { createAppStore } from "./createAppStore";
import { FileDropCoordinator, type FileDropDependencies } from "./FileDropCoordinator";

const disk = vi.hoisted(() => ({
  readImageBytes: vi.fn<(path: string) => Promise<ImageBytes>>(),
  /** Gives the copy's link from the document, as the main process does. */
  writeAttachment: vi.fn<(docPath: string, folder: string, name: string) => Promise<string>>(),
}));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  readImageBytes: disk.readImageBytes,
  writeAttachment: disk.writeAttachment,
}));

/** Where the files were dropped, on a line of the document. */
const point: DropPoint = { clientX: 40, clientY: 120, target: null };
const image = "![](data:image/png;base64,AQID)";
const link = "[data.csv](attachments/data.csv)";

/**
 * A coordinator with a fake editor and file service that log, in order, each
 * aim, insert, release, new document and open. As in EditorHost, a file only
 * goes into the document it was dropped on while that document is in front,
 * and waits while it is behind another tab. An insert logs which tab was in
 * front then. While a test holds `saveAs.underWay`, a Save As of the document
 * is under way, so `untilPathSettled` waits for it.
 */
function setup() {
  const store = createAppStore();
  store.patchDoc({ filePath: "/docs/notes.md" });
  const droppedOn = store.get().activeTabId;
  if (droppedOn === null) throw new Error("The app store starts with a tab.");
  const log: string[] = [];
  /** A tab's name in the log. That is "dropped-on" for the document the
   *  files were dropped on, else its path or "untitled". */
  const tab = (tabId: string | null): string =>
    tabId === droppedOn ? "dropped-on" : (store.get().tabs.find((t) => t.id === tabId)?.doc.filePath ?? "untitled");
  /** Resolve true once a tab is in front, or false once it is closed. */
  const untilActive = (tabId: string): Promise<boolean> =>
    new Promise((resolve) => {
      const state = (): boolean | null =>
        store.get().activeTabId === tabId ? true : store.get().tabs.some((t) => t.id === tabId) ? null : false;
      if (state() !== null) return resolve(state()!);
      const stop = store.subscribe(() => {
        const now = state();
        if (now === null) return;
        stop();
        resolve(now);
      });
    });
  const editorHost: FileDropDependencies["editorHost"] = {
    aimDrop: vi.fn((at?: DropPoint) => {
      log.push(at ? "aim at the drop point" : "aim at the caret");
      const tabId = store.get().activeTabId;
      return tabId === null ? null : { tabId };
    }),
    insertDropped: async (drop: FileDrop, markdown: string) => {
      if (!(await untilActive(drop.tabId))) return false;
      log.push(`insert ${markdown} into ${tab(drop.tabId)} with ${tab(store.get().activeTabId)} in front`);
      return true;
    },
    releaseDrop: (drop: FileDrop) => {
      log.push(`release ${tab(drop.tabId)}`);
    },
    untilInFront: (drop: FileDrop) => untilActive(drop.tabId),
  };
  const saveAs: { underWay: Promise<void> | null } = { underWay: null };
  const files: FileDropDependencies["files"] = {
    untilPathSettled: async () => {
      while (saveAs.underWay) await saveAs.underWay;
    },
    newDocument: async () => {
      log.push("new document");
      store.addTab(blankDoc());
    },
    openPath: async (path: string) => {
      log.push(`open ${path}`);
      store.addTab({ ...blankDoc(), filePath: path });
    },
    save: async () => true,
  };
  const coordinator = new FileDropCoordinator({ store, files, editorHost, showActiveDoc: async () => {} });
  return { store, log, files, editorHost, coordinator, droppedOn, saveAs };
}

/** A promise and the function that resolves it. */
function held<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  disk.readImageBytes.mockReset();
  disk.readImageBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
  disk.writeAttachment.mockReset();
  disk.writeAttachment.mockImplementation(async (_docPath, folder, name) => `${folder}/${name}`);
});

describe("FileDropCoordinator", () => {
  it("puts the other files of a drop with Markdown files where they were dropped, then opens every Markdown file", async () => {
    const { store, log, editorHost, coordinator } = setup();
    const handled = coordinator.handle(["/drop/a.md", "/drop/pic.png", "/drop/data.csv", "/drop/b.md"], point);
    // Aimed during the drop event, before the drop point's text can move.
    expect(editorHost.aimDrop).toHaveBeenCalledWith(point);
    await handled;
    expect(log).toEqual([
      "aim at the drop point",
      `insert ${image} into dropped-on with dropped-on in front`,
      `insert ${link} into dropped-on with dropped-on in front`,
      "release dropped-on",
      "open /drop/a.md",
      "open /drop/b.md",
    ]);
    expect(store.get().tabs.map((t) => t.doc.filePath)).toEqual(["/docs/notes.md", "/drop/a.md", "/drop/b.md"]);
  });

  it("opens the Markdown files at once when the user shows another tab while the other files are read", async () => {
    const { store, log, coordinator, droppedOn } = setup();
    const otherTab = store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    store.activateTab(droppedOn);
    let finishRead = () => {};
    disk.readImageBytes.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
      }),
    );
    const handled = coordinator.handle(["/drop/pic.png", "/drop/a.md"], point);
    await settle();
    expect(log).toEqual(["aim at the drop point"]);
    // The user shows another tab while the image is read. The Markdown file
    // does not wait with the image for the user to come back.
    store.activateTab(otherTab);
    await settle();
    expect(log).toEqual(["aim at the drop point", "open /drop/a.md"]);
    finishRead();
    await settle();
    expect(log).toEqual(["aim at the drop point", "open /drop/a.md"]);
    // Back on the document it was dropped on, the image goes in, and that
    // document stays in front.
    store.activateTab(droppedOn);
    await handled;
    expect(log).toEqual([
      "aim at the drop point",
      "open /drop/a.md",
      `insert ${image} into dropped-on with dropped-on in front`,
      "release dropped-on",
    ]);
    expect(store.get().activeTabId).toBe(droppedOn);
  });

  it("opens every Markdown file of a drop of only Markdown files, aiming nothing", async () => {
    const { log, coordinator } = setup();
    await coordinator.handle(["/drop/a.md", "/drop/b.markdown"], point);
    expect(log).toEqual(["open /drop/a.md", "open /drop/b.markdown"]);
  });

  it("puts the other files into a new document when none is open, then opens the Markdown file", async () => {
    const { store, log, coordinator } = setup();
    store.set({ tabs: [], activeTabId: null, doc: blankDoc(), view: "recent" });
    await coordinator.handle(["/drop/a.md", "/drop/pic.png"], point);
    expect(log).toEqual([
      "new document",
      "aim at the caret",
      `insert ${image} into untitled with untitled in front`,
      "release untitled",
      "open /drop/a.md",
    ]);
  });

  it("opens the other Markdown files of a drop when one cannot be opened", async () => {
    const { log, files, coordinator } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const open = files.openPath;
    files.openPath = async (path) => {
      if (path === "/drop/gone.md") throw new Error("missing");
      await open(path);
    };
    await coordinator.handle(["/drop/gone.md", "/drop/b.md"], point);
    expect(log).toEqual(["open /drop/b.md"]);
    expect(logged).toHaveBeenCalledWith("md-easy: could not open gone.md", expect.any(Error));
    logged.mockRestore();
  });

  it("puts the files after one that cannot be read into the document, then opens the Markdown files", async () => {
    const { log, coordinator } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = disk.readImageBytes.getMockImplementation()!;
    disk.readImageBytes.mockImplementation(async (path) => {
      if (path === "/drop/gone.png") throw new Error("missing");
      return read(path);
    });
    await coordinator.handle(["/drop/gone.png", "/drop/data.csv", "/drop/pic.png", "/drop/a.md"], point);
    expect(log).toEqual([
      "aim at the drop point",
      `insert ${link} into dropped-on with dropped-on in front`,
      `insert ${image} into dropped-on with dropped-on in front`,
      "release dropped-on",
      "open /drop/a.md",
    ]);
    expect(disk.writeAttachment).toHaveBeenCalledWith("/docs/notes.md", "attachments", "data.csv", expect.any(Uint8Array));
    expect(logged).toHaveBeenCalledWith("md-easy: could not insert gone.png", expect.any(Error));
    logged.mockRestore();
  });

  it("copies a file beside the document that was saved in another folder while the file was read", async () => {
    const { store, log, coordinator } = setup();
    let finishRead = () => {};
    disk.readImageBytes.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "text/csv" });
      }),
    );
    const handled = coordinator.handle(["/drop/data.csv"], point);
    await settle();
    // Save As puts the document in another folder.
    store.patchDoc({ filePath: "/moved/notes.md" });
    finishRead();
    await handled;
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    expect(disk.writeAttachment).toHaveBeenCalledWith("/moved/notes.md", "attachments", "data.csv", expect.any(Uint8Array));
    expect(log).toContain(`insert ${link} into dropped-on with dropped-on in front`);
  });

  it("copies a file beside the document where a Save As under way once the file is read puts it", async () => {
    const { store, log, coordinator, saveAs } = setup();
    const read = held<ImageBytes>();
    disk.readImageBytes.mockReturnValueOnce(read.promise);
    const handled = coordinator.handle(["/drop/data.csv"], point);
    await settle();
    // The user starts Save As during the read, and is still in its dialog.
    const saved = held();
    saveAs.underWay = saved.promise;
    read.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "text/csv" });
    await settle();
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    store.patchDoc({ filePath: "/moved/notes.md" });
    saveAs.underWay = null;
    saved.resolve();
    await handled;
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    expect(disk.writeAttachment).toHaveBeenCalledWith("/moved/notes.md", "attachments", "data.csv", expect.any(Uint8Array));
    expect(log).toContain(`insert ${link} into dropped-on with dropped-on in front`);
  });

  it.each([
    ["a file", "/drop/data.csv", (src: string) => `[data.csv](${src})`],
    ["an image stored as a file", "/drop/pic.png", (src: string) => `![](${src})`],
  ])("stores %s again beside the document when the document is saved in another folder while it is written", async (_kind, dropped, markdown) => {
    const { store, log, coordinator } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    const write = held<string>();
    disk.writeAttachment.mockReturnValueOnce(write.promise);
    const handled = coordinator.handle([dropped], point);
    await settle();
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    const [docPath, folder, name] = disk.writeAttachment.mock.calls[0]!;
    expect(docPath).toBe("/docs/notes.md");
    store.patchDoc({ filePath: "/moved/notes.md" });
    write.resolve(`${folder}/${name}`);
    await handled;
    // The copy beside the old place stays, and the link leads to the new one.
    expect(disk.writeAttachment).toHaveBeenCalledTimes(2);
    expect(disk.writeAttachment).toHaveBeenLastCalledWith("/moved/notes.md", folder, name, expect.any(Uint8Array));
    expect(log).toContain(`insert ${markdown(`${folder}/${name}`)} into dropped-on with dropped-on in front`);
  });

  it("stores no copy of a file dropped on a document that is closed while the file is read", async () => {
    const { store, log, coordinator, droppedOn } = setup();
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    store.activateTab(droppedOn);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = held<ImageBytes>();
    disk.readImageBytes.mockReturnValueOnce(read.promise);
    const handled = coordinator.handle(["/drop/data.csv"], point);
    await settle();
    store.closeTab(droppedOn);
    read.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "text/csv" });
    await handled;
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    expect(log).toEqual(["aim at the drop point", "release dropped-on"]);
    expect(warned).toHaveBeenCalledWith("md-easy: data.csv was not inserted, because the document it was dropped on was closed");
    warned.mockRestore();
  });
});
