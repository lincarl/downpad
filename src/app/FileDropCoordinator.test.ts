import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DropPoint, FileDrop } from "../editor/EditorHost";
import type { ImageBytes } from "../ipc/contracts";
import { blankDoc } from "../state/types";
import { forgetImageAnswers } from "../editor/wysiwyg/imageView";
import { createAppStore } from "./createAppStore";
import { FileDropCoordinator, type FileDropDependencies } from "./FileDropCoordinator";
import { takesNoFiles } from "../files/documentLanguage";

const disk = vi.hoisted(() => ({
  readImageBytes: vi.fn<(path: string) => Promise<ImageBytes>>(),
  /** Gives the copy's link from the document, as the main process does. */
  writeAttachment: vi.fn<(docPath: string, folder: string, name: string) => Promise<string>>(),
  /** Whether the app runs in Electron, where local images are looked up. */
  isElectron: vi.fn(() => false),
  /** Answers the app's question about a local image's URL. */
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
}));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  readImageBytes: disk.readImageBytes,
  writeAttachment: disk.writeAttachment,
}));
vi.mock("../ipc/env", () => ({ isElectron: disk.isElectron }));
vi.mock("../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge")>()),
  convertFileSrc: disk.convertFileSrc,
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
 * is under way, so `untilPathSettled` waits for it. While it holds
 * `turn.waits`, an earlier drop or paste into the document is under way, so
 * `untilTurn` waits for it.
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
      // As EditorHost does, refuse a document that is a JSON or YAML file by now.
      const refusal = takesNoFiles(store.get().tabs.find((t) => t.id === drop.tabId)?.doc.filePath ?? null);
      if (refusal) throw refusal;
      log.push(`insert ${markdown} into ${tab(drop.tabId)} with ${tab(store.get().activeTabId)} in front`);
      return true;
    },
    aimPaste: vi.fn((tabId: string) => {
      log.push(`aim the paste at the caret in ${tab(tabId)}`);
      return store.get().activeTabId === tabId ? { tabId } : null;
    }),
    releaseDrop: (drop: FileDrop) => {
      log.push(`release ${tab(drop.tabId)}`);
    },
    untilInFront: (drop: FileDrop) => untilActive(drop.tabId),
    untilTurn: async () => {
      while (turn.waits) await turn.waits;
    },
  };
  const turn: { waits: Promise<void> | null } = { waits: null };
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
  /** Whether the last notice still shows, which a test can end. */
  const notice = { shows: true };
  const reportFailure = vi.fn<(message: string) => () => boolean>(() => () => notice.shows);
  const coordinator = new FileDropCoordinator({ store, files, editorHost, showActiveDoc: async () => {}, reportFailure });
  return { store, log, files, editorHost, coordinator, droppedOn, saveAs, turn, reportFailure, notice };
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
  disk.isElectron.mockReturnValue(false);
  disk.convertFileSrc.mockReset();
  forgetImageAnswers();
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

  it.each([
    { first: "still shows", shows: true, later: "Downpad could not add “pic.png”. The file or folder does not exist. Downpad could not open “bad.md”. The file is not valid UTF-8." },
    { first: "is gone", shows: false, later: "Downpad could not add “pic.png”. The file or folder does not exist." },
  ])("names the Markdown files that did not open at once, and the files left out later, with the Markdown files again when the first notice $first", async ({ shows, later }) => {
    const { store, files, coordinator, droppedOn, reportFailure, notice } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const otherTab = store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    store.activateTab(droppedOn);
    let failRead = () => {};
    disk.readImageBytes.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failRead = () => reject(new Error("ENOENT: no such file or directory, open '/drop/pic.png'"));
      }),
    );
    const open = files.openPath;
    files.openPath = async (path) => {
      if (path === "/drop/bad.md") throw new Error("The file is not valid UTF-8.");
      await open(path);
    };
    const handled = coordinator.handle(["/drop/pic.png", "/drop/bad.md", "/drop/a.md"], point);
    await settle();
    // The user shows another tab while the image is read.
    store.activateTab(otherTab);
    await settle();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("Downpad could not open “bad.md”. The file is not valid UTF-8.");
    notice.shows = shows;
    failRead();
    await handled;
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenLastCalledWith(later);
    logged.mockRestore();
  });

  it("shows no second notice when the files that waited all went in", async () => {
    const { store, files, coordinator, droppedOn, reportFailure } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const otherTab = store.addTab({ ...blankDoc(), filePath: "/docs/other.md" });
    store.activateTab(droppedOn);
    let finishRead = () => {};
    disk.readImageBytes.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
      }),
    );
    const open = files.openPath;
    files.openPath = async (path) => {
      if (path === "/drop/bad.md") throw new Error("The file is not valid UTF-8.");
      await open(path);
    };
    const handled = coordinator.handle(["/drop/pic.png", "/drop/bad.md"], point);
    await settle();
    store.activateTab(otherTab);
    await settle();
    finishRead();
    store.activateTab(droppedOn);
    await handled;
    logged.mockRestore();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("Downpad could not open “bad.md”. The file is not valid UTF-8.");
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

  it("opens the other Markdown files of a drop when some cannot be opened, and names those in one notice", async () => {
    const { log, files, coordinator, reportFailure } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const open = files.openPath;
    files.openPath = async (path) => {
      if (path.includes("gone")) throw new Error("Error invoking remote method 'command': Error: ENOENT: no such file or directory, open '/drop/gone.md'");
      await open(path);
    };
    await coordinator.handle(["/drop/gone.md", "/drop/b.md", "/drop/gone too.md"], point);
    expect(log).toEqual(["open /drop/b.md"]);
    expect(logged).toHaveBeenCalledWith("Downpad: could not open gone.md", expect.any(Error));
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("Downpad could not open “gone.md”, “gone too.md”. The file or folder does not exist.");
    logged.mockRestore();
  });

  it("names the files left out and the Markdown files that did not open in one notice, after the last file opened, each with its reason", async () => {
    const { log, files, coordinator, reportFailure } = setup();
    reportFailure.mockImplementation(() => {
      log.push("notice");
      return () => true;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = disk.readImageBytes.getMockImplementation()!;
    disk.readImageBytes.mockImplementation(async (path) => {
      if (path === "/drop/gone.png") throw new Error("ENOENT: no such file or directory, open '/drop/gone.png'");
      if (path === "/drop/locked.png") throw new Error("EACCES: permission denied, open '/drop/locked.png'");
      return read(path);
    });
    const open = files.openPath;
    files.openPath = async (path) => {
      if (path === "/drop/binary.md") throw new Error("The file is not valid UTF-8.");
      if (path === "/drop/gone.md") throw new Error("ENOENT: no such file or directory, open '/drop/gone.md'");
      await open(path);
    };
    await coordinator.handle(["/drop/gone.png", "/drop/locked.png", "/drop/binary.md", "/drop/gone.md", "/drop/a.md"], point);
    // The notice comes after the last Markdown file opened.
    expect(log.slice(-2)).toEqual(["open /drop/a.md", "notice"]);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      "Downpad could not add “gone.png”. The file or folder does not exist. "
      + "Downpad could not add “locked.png”. Permission was denied, or another program is using the file. "
      + "Downpad could not open “binary.md”. The file is not valid UTF-8. "
      + "Downpad could not open “gone.md”. The file or folder does not exist.",
    );
    logged.mockRestore();
  });

  it("names every file of a drop that no document was ready to take, and still opens its Markdown files", async () => {
    const { log, editorHost, coordinator, reportFailure } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // The editor is still being built, so nothing can take the files.
    editorHost.aimDrop = () => null;
    await coordinator.handle(["/drop/pic.png", "/drop/data.csv", "/drop/a.md"], point);
    logged.mockRestore();
    expect(log).toEqual(["open /drop/a.md"]);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("Downpad could not add “pic.png”, “data.csv”. No document was ready to take the file. Try again.");
  });

  it("opens a dropped JSON or YAML file in a tab, as a Markdown file, and stores no copy of it", async () => {
    const { store, log, coordinator, reportFailure } = setup();
    await coordinator.handle(["/drop/package.json", "/drop/compose.yaml", "/drop/ci.yml"], point);
    expect(log).toEqual(["open /drop/package.json", "open /drop/compose.yaml", "open /drop/ci.yml"]);
    expect(store.get().tabs.map((t) => t.doc.filePath)).toEqual(["/docs/notes.md", "/drop/package.json", "/drop/compose.yaml", "/drop/ci.yml"]);
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("puts no file into a JSON or YAML file, says why, and still opens the drop's documents", async () => {
    for (const [path, kind] of [["/data/settings.json", "JSON"], ["/data/compose.yml", "YAML"]]) {
      const { store, log, editorHost, coordinator, reportFailure } = setup();
      store.patchDoc({ filePath: path });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await coordinator.handle(["/drop/pic.png", "/drop/data.csv", "/drop/a.md"], point);
      logged.mockRestore();
      // Nothing is aimed, read or stored for a document that takes no files.
      expect(log).toEqual(["open /drop/a.md"]);
      expect(editorHost.aimDrop).not.toHaveBeenCalled();
      expect(disk.readImageBytes).not.toHaveBeenCalled();
      expect(disk.writeAttachment).not.toHaveBeenCalled();
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
        `Downpad could not add “pic.png”, “data.csv”. A ${kind} file takes no dropped files. Drop them on a Markdown document.`,
      );
    }
  });

  it("puts no file into an untitled document that the drop's own save made a JSON file, and stores no copy beside it", async () => {
    const { store, log, files, coordinator, reportFailure } = setup();
    store.patchDoc({ filePath: null, markdown: "{}" });
    // The drop asks where to save the untitled document, and the user names it config.json.
    files.save = async () => {
      store.patchDoc({ filePath: "/docs/config.json" });
      return true;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await coordinator.handle(["/drop/report.pdf"], point);
    logged.mockRestore();
    expect(log).toEqual(["aim at the drop point", "release dropped-on"]);
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      "Downpad could not add “report.pdf”. A JSON file takes no dropped files. Drop them on a Markdown document.",
    );
  });

  it("stores no copy of an image beside an untitled document that the drop's own save made a JSON file", async () => {
    const { store, log, files, coordinator, reportFailure } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    store.patchDoc({ filePath: null, markdown: "{}" });
    files.save = async () => {
      store.patchDoc({ filePath: "/docs/config.json" });
      return true;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await coordinator.handle(["/drop/pic.png"], point);
    logged.mockRestore();
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    expect(log).toEqual(["aim at the drop point", "release dropped-on"]);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      "Downpad could not add “pic.png”. A JSON file takes no dropped files. Drop them on a Markdown document.",
    );
  });

  it("puts no image into a document that was saved as YAML while the image was read", async () => {
    const { store, log, coordinator, reportFailure } = setup();
    const read = held<ImageBytes>();
    disk.readImageBytes.mockReturnValueOnce(read.promise);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = coordinator.handle(["/drop/pic.png"], point);
    await settle();
    store.patchDoc({ filePath: "/docs/notes.yaml" });
    read.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    await handled;
    logged.mockRestore();
    expect(log).toEqual(["aim at the drop point", "release dropped-on"]);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      "Downpad could not add “pic.png”. A YAML file takes no dropped files. Drop them on a Markdown document.",
    );
  });

  it("puts a file dropped on the Recent view into no JSON file behind it", async () => {
    const { store, log, coordinator, reportFailure } = setup();
    store.patchDoc({ filePath: "/data/settings.json" });
    store.set({ view: "recent" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await coordinator.handle(["/drop/pic.png"], point);
    logged.mockRestore();
    expect(log).toEqual([]);
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("shows no notice for a drop whose files all open and go in", async () => {
    const { coordinator, reportFailure } = setup();
    await coordinator.handle(["/drop/pic.png", "/drop/a.md"], point);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("puts the files after one that cannot be read into the document, names it in a notice, then opens the Markdown files", async () => {
    const { log, coordinator, reportFailure } = setup();
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
    expect(logged).toHaveBeenCalledWith("Downpad: could not insert gone.png", expect.any(Error));
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("Downpad could not add “gone.png”. missing");
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
  ])("stores %s again beside the document when the document is saved in another folder while it is written", async (kind, dropped, markdown) => {
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
    // An image's name comes from the clock, so the second write can differ.
    expect(disk.writeAttachment).toHaveBeenCalledTimes(2);
    const again = disk.writeAttachment.mock.calls[1]![2];
    expect(again).toMatch(kind === "a file" ? /^data\.csv$/ : /^img-.+\.png$/);
    expect(disk.writeAttachment).toHaveBeenLastCalledWith("/moved/notes.md", folder, again, expect.any(Uint8Array));
    expect(log).toContain(`insert ${markdown(`${folder}/${again}`)} into dropped-on with dropped-on in front`);
  });

  it("embeds a dropped image at once while a Save As of the document is under way", async () => {
    const { log, coordinator, saveAs } = setup();
    // A data URI holds the image wherever the document is saved.
    saveAs.underWay = new Promise(() => {});
    await coordinator.handle(["/drop/pic.png"], point);
    expect(log).toEqual(["aim at the drop point", `insert ${image} into dropped-on with dropped-on in front`, "release dropped-on"]);
  });

  it("looks up the URL of an image stored as a file before the image goes in", async () => {
    const { store, log, coordinator } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    disk.isElectron.mockReturnValue(true);
    const answer = held<string | null>();
    disk.convertFileSrc.mockImplementation((path) => {
      log.push(`look up ${path}`);
      return answer.promise;
    });
    const handled = coordinator.handle(["/drop/pic.png"], point);
    await settle();
    const [, folder, name] = disk.writeAttachment.mock.calls[0]!;
    // The image waits for the answer, so its view starts at the image's URL
    // rather than at its path next to Downpad's own page.
    expect(log).toEqual(["aim at the drop point", `look up /docs/${folder}/${name}`]);
    answer.resolve("downpad-file://pic");
    await handled;
    expect(log).toEqual([
      "aim at the drop point",
      `look up /docs/${folder}/${name}`,
      `insert ![](${folder}/${name}) into dropped-on with dropped-on in front`,
      "release dropped-on",
    ]);
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
    expect(warned).toHaveBeenCalledWith("Downpad: data.csv was not inserted, because its document was closed");
    warned.mockRestore();
  });
});

/** A PNG image file as the clipboard holds it after a screenshot. */
const pastedPng = () => new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

describe("FileDropCoordinator pasted images", () => {
  it("puts pasted images in at the caret where they were pasted, in paste order, then ends the paste", async () => {
    const { log, editorHost, coordinator, droppedOn } = setup();
    const pasting = coordinator.pasteImages(droppedOn, [pastedPng(), pastedPng()]);
    // Aimed during the paste event, before the caret can move.
    expect(editorHost.aimPaste).toHaveBeenCalledWith(droppedOn);
    await pasting;
    expect(log).toEqual([
      "aim the paste at the caret in dropped-on",
      `insert ${image} into dropped-on with dropped-on in front`,
      `insert ${image} into dropped-on with dropped-on in front`,
      "release dropped-on",
    ]);
  });

  it("names a pasted image that could not be stored in a notice, and shows none for a paste that went in", async () => {
    const { store, log, coordinator, droppedOn, reportFailure } = setup();
    await coordinator.pasteImages(droppedOn, [pastedPng()]);
    expect(reportFailure).not.toHaveBeenCalled();

    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    disk.writeAttachment.mockRejectedValueOnce(new Error("ENOSPC: no space left on device, write"));
    log.length = 0;
    await coordinator.pasteImages(droppedOn, [pastedPng()]);
    logged.mockRestore();
    expect(log).toEqual(["aim the paste at the caret in dropped-on", "release dropped-on"]);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Downpad could not add “.+”\. The disk is full\.$/));
  });

  it("writes a pasted image stored as a file beside the document where a Save As under way puts it", async () => {
    const { store, log, coordinator, droppedOn, saveAs } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    const saved = held();
    saveAs.underWay = saved.promise;
    const pasting = coordinator.pasteImages(droppedOn, [pastedPng()]);
    await settle();
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    store.patchDoc({ filePath: "/moved/notes.md" });
    saveAs.underWay = null;
    saved.resolve();
    await pasting;
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    const [docPath, folder, name] = disk.writeAttachment.mock.calls[0]!;
    expect(docPath).toBe("/moved/notes.md");
    expect(log).toContain(`insert ![](${folder}/${name}) into dropped-on with dropped-on in front`);
  });

  // The file would otherwise go in with a link from the old folder, which a
  // Save As while it waits for the files before it no longer resolves.
  it.each([
    ["pasted", (coordinator: FileDropCoordinator, droppedOn: string) => coordinator.pasteImages(droppedOn, [pastedPng()])],
    ["dropped", (coordinator: FileDropCoordinator) => coordinator.handle(["/drop/pic.png"], point)],
  ])("writes an image %s while an earlier one is under way beside the document where a Save As meanwhile puts it", async (_kind, put) => {
    const { store, log, coordinator, droppedOn, turn } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    const earlier = held();
    turn.waits = earlier.promise;
    const putting = put(coordinator, droppedOn);
    await settle();
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    store.patchDoc({ filePath: "/moved/notes.md" });
    turn.waits = null;
    earlier.resolve();
    await putting;
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    const [docPath, folder, name] = disk.writeAttachment.mock.calls[0]!;
    expect(docPath).toBe("/moved/notes.md");
    expect(log).toContain(`insert ![](${folder}/${name}) into dropped-on with dropped-on in front`);
  });

  it("puts nothing in for an image pasted into an untitled document whose save the user cancels", async () => {
    const { store, log, files, coordinator, droppedOn } = setup();
    store.patchDoc({ filePath: null });
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    files.save = async () => {
      log.push("ask where to save");
      return false;
    };
    await coordinator.pasteImages(droppedOn, [pastedPng()]);
    // Crepe's upload plugin put in an image without a src here.
    expect(log).toEqual(["aim the paste at the caret in dropped-on", "ask where to save", "release dropped-on"]);
    expect(disk.writeAttachment).not.toHaveBeenCalled();
  });

  it("stores nothing and saves no other document for an image pasted into a document closed while a Save As of it is under way", async () => {
    const { store, log, files, coordinator, droppedOn, saveAs } = setup();
    store.set((state) => ({ settings: { ...state.settings, embedImagesAsBase64: false } }));
    store.addTab({ ...blankDoc(), filePath: "/docs/other.md", isDirty: true });
    store.activateTab(droppedOn);
    const save = vi.spyOn(files, "save");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = held();
    saveAs.underWay = saved.promise;
    const pasting = coordinator.pasteImages(droppedOn, [pastedPng()]);
    await settle();
    store.closeTab(droppedOn);
    saveAs.underWay = null;
    saved.resolve();
    await pasting;
    expect(disk.writeAttachment).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(log).toEqual(["aim the paste at the caret in dropped-on", "release dropped-on"]);
    expect(warned).toHaveBeenCalledWith("Downpad: image.png was not inserted, because its document was closed");
    warned.mockRestore();
  });
});
