// Files dropped from the desktop (spec §5.4), and images pasted into the
// document view (§5.5). Each dropped Markdown file opens in a tab, as does a
// text, JSON or YAML file, which the code below counts as one. Other
// dropped files go into the document they were dropped on, an image as an
// image and any other file as a link to its copy in the attachments folder. A
// pasted image goes in the same way, at the caret where it was pasted.
// EditorHost decides where in that document each file goes, and holds a file
// back while its document is behind another tab. A file that cannot be read
// or stored is left out, and the drop's other files still go in. Only a
// Markdown document takes files, since a file goes in as a Markdown image or
// link.

import type { DropPoint, EditorHost, FileDrop } from "../editor/EditorHost";
import { lookUpImages } from "../editor/wysiwyg/imageView";
import type { FileService } from "../files/FileService";
import { documentLanguage, LANGUAGE_NAMES } from "../files/documentLanguage";
import { resolveImageSrc, storeBesideDocument, type ImageStoreContext } from "../images/imageStore";
import { readImageBytes, writeAttachment } from "../ipc/commands";
import type { ImageBytes } from "../ipc/contracts";
import { failureReason } from "../ipc/failureReason";
import { baseName, classifyDrop } from "../paste/dropHandler";
import { mdImage, mdLink } from "../paste/mdLink";
import type { Store } from "../state/store";

export interface FileDropDependencies {
  store: Store;
  files: Pick<FileService, "newDocument" | "openPath" | "save" | "untilPathSettled">;
  editorHost: Pick<EditorHost, "aimDrop" | "aimPaste" | "insertDropped" | "releaseDrop" | "untilInFront" | "untilTurn">;
  /** Show the active tab's document in the editor, leaving the Recent view. */
  showActiveDoc(): Promise<void>;
  /** Show the user an error notice. Returns a function that tells whether
   *  that notice still shows. */
  reportFailure(message: string): () => boolean;
}

/** A dropped or pasted file, by its name, that Downpad could not add to the
 *  document or open, with the error that says why. */
interface Failure {
  action: "add" | "open";
  name: string;
  error: unknown;
}

/** Whether `promise` has settled by now. */
async function settledBy(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(pending)])) !== pending;
}

/** Opens or inserts the files of each desktop drop. */
export class FileDropCoordinator {
  constructor(private readonly dependencies: FileDropDependencies) {}

  /**
   * Handle the files of one drop. Each Markdown file opens as an opened file
   * does, in drop order, so the last one ends in front. The other files go
   * into the document they were dropped on. Images embed where they were
   * dropped, or at the caret, and other files are copied into the attachments
   * folder and linked the same way. A file that cannot be read or stored is
   * left out, and the others still go in. Once its Markdown files open, one
   * error notice names the files left out and the Markdown files that did
   * not open, with the reason of each. Files that are not in by then, such
   * as ones that wait for their document to be in front again, name the
   * ones left out in a later notice, which names the Markdown files again
   * while the first notice still shows. A file only goes into
   * the document in front, so those files go in first and the Markdown files
   * open once they are in. A new tab would otherwise put the document behind
   * it while they are read. Those files go in after the files of earlier
   * drops and pastes into the document, so a slow earlier file holds back
   * the Markdown files too. If the document goes behind another tab before
   * then, its files wait until it is shown again, and the Markdown files open
   * at once rather than wait with them. Call this while handling the drop
   * event, because it reads where the files go from `point` before it first
   * awaits.
   */
  async handle(paths: string[], point: DropPoint): Promise<void> {
    const markdown = paths.filter((path) => classifyDrop(path) === "document");
    const others = paths.filter((path) => classifyDrop(path) !== "document");
    let inserted: Promise<Failure[]> = Promise.resolve([]);
    try {
      const drop = others.length > 0 ? await this.aim(point) : null;
      if (drop) {
        inserted = this.insertFiles(others, drop);
        await this.untilInsertedOrBehind(inserted, drop.tabId);
      } else if (others.length > 0) {
        throw new Error("No document was ready to take the file. Try again.");
      }
    } catch (error) {
      // No document could take the files. The Markdown files still open.
      console.error("Downpad: could not take the dropped files", error);
      inserted = Promise.resolve(others.map((path) => ({ action: "add", name: baseName(path), error })));
    }
    const unopened: Failure[] = [];
    for (const path of markdown) {
      const error = await this.openMarkdown(path);
      if (error !== null) unopened.push({ action: "open", name: baseName(path), error });
    }
    // One notice for the whole drop, after its last tab opened, since a tab
    // that comes to the front clears the notice bar. Files that wait until
    // their document is in front again report on their own once they are in,
    // so the Markdown files that did not open do not wait with them.
    if (await settledBy(inserted)) this.report([...(await inserted), ...unopened]);
    else {
      const stillShown = this.report(unopened);
      const leftOut = await inserted;
      // The later notice names the Markdown files again while the first one
      // still shows, so it does not take them away before they were read.
      if (leftOut.length > 0) this.report(stillShown?.() ? [...leftOut, ...unopened] : leftOut);
    }
  }

  /**
   * Put images pasted into a tab's document view in at the caret where they
   * were pasted (§5.5), in the order they were pasted, as the files of a drop
   * away from the text go in. They go in after the files of every earlier
   * paste or drop into the document, even if they are stored first
   * (`EditorHost.insertDropped`). Each waits while its document is behind
   * another tab, and goes into the view shown once it is stored, at the
   * caret there if the place it was pasted is gone, such as after the
   * document view was rebuilt. An untitled document asks where to save it
   * for an image stored in the attachments folder once it is in front, and
   * nothing goes in if the user cancels. Call this while handling the paste
   * event, because it reads the caret before it first awaits.
   */
  async pasteImages(tabId: string, files: readonly File[]): Promise<void> {
    const drop = this.dependencies.editorHost.aimPaste(tabId);
    if (!drop) return;
    this.report(await this.insertEach(drop, files, (file) => file.name, async (file) => {
      const image = { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || "image/png" };
      await this.embedImage(image, drop, file.name);
    }));
  }

  /** Aim a drop's files that are not Markdown files at the document they were
   *  dropped on. Resolves null if no document can take them. */
  private async aim(point: DropPoint): Promise<FileDrop | null> {
    const { store, files, editorHost } = this.dependencies;
    // Aim now, during the drop event, while the drop point is over the text the
    // file was dropped on. Reading the file comes after. With no document open,
    // create one first so the drop has somewhere to go, and from the Recent
    // view show the document. The files then go in at its caret.
    const { activeTabId, view } = store.get();
    if (activeTabId) this.refuseDataFile(activeTabId);
    let drop: FileDrop | null = null;
    if (!activeTabId) await files.newDocument();
    else if (view === "recent") await this.dependencies.showActiveDoc();
    else drop = editorHost.aimDrop(point);
    return drop ?? editorHost.aimDrop();
  }

  /** Put a drop's files that are not Markdown files into the document they
   *  were dropped on, in the order they were dropped, and end the drop. A
   *  file that cannot be read or stored, such as one deleted since the drop,
   *  is logged and left out, and the files after it still go in. Resolves
   *  with the files left out. */
  private insertFiles(paths: string[], drop: FileDrop): Promise<Failure[]> {
    return this.insertEach(drop, paths, baseName, async (path) => {
      if (classifyDrop(path) === "image") await this.embedImage(await readImageBytes(path), drop, baseName(path));
      else await this.attachDroppedFile(path, drop);
    });
  }

  /** Put each file of a drop or paste into its document with `insert`, in
   *  order, and end the drop. A file that cannot be read or stored is logged
   *  by its `name` and left out, and the files after it still go in.
   *  Resolves with the files left out. */
  private async insertEach<T>(drop: FileDrop, files: readonly T[], name: (file: T) => string, insert: (file: T) => Promise<void>): Promise<Failure[]> {
    const failures: Failure[] = [];
    try {
      for (const file of files) {
        try {
          await insert(file);
        } catch (error) {
          console.error(`Downpad: could not insert ${name(file)}`, error);
          failures.push({ action: "add", name: name(file), error });
        }
      }
    } finally {
      this.dependencies.editorHost.releaseDrop(drop);
    }
    return failures;
  }

  /** Tell the user in one error notice which files Downpad could not add to
   *  the document or open. Files that failed the same way share a sentence
   *  with their reason. Returns a function that tells whether the notice
   *  still shows, or null when there was nothing to tell. */
  private report(failures: readonly Failure[]): (() => boolean) | null {
    const groups = new Map<string, { action: string; reason: string; names: string[] }>();
    for (const { action, name, error } of failures) {
      const reason = failureReason(error);
      const key = JSON.stringify([action, reason]);
      const group = groups.get(key) ?? { action, reason, names: [] };
      group.names.push(`“${name}”`);
      groups.set(key, group);
    }
    if (groups.size === 0) return null;
    const sentences = [...groups.values()].map(({ action, reason, names }) => `Downpad could not ${action} ${names.join(", ")}. ${reason}`.trimEnd());
    return this.dependencies.reportFailure(sentences.join(" "));
  }

  /** Resolve once a drop's files are in, or once the document they were
   *  dropped on is no longer in front, whichever comes first. A new tab can
   *  no longer put that document behind it then, and its files wait for it
   *  anyway. */
  private async untilInsertedOrBehind(inserted: Promise<unknown>, tabId: string): Promise<void> {
    const { store } = this.dependencies;
    let stop = (): void => {};
    const behind = new Promise<void>((resolve) => {
      stop = store.select(
        (state) => state.activeTabId === tabId,
        (inFront) => {
          if (!inFront) resolve();
        },
      );
    });
    try {
      if (store.get().activeTabId === tabId) await Promise.race([inserted, behind]);
    } finally {
      stop();
    }
  }

  /** Open a dropped Markdown file as `FileService.openPath` does (§5.19). It
   *  opens in a tab of its own, or in place of an empty untitled document, or
   *  shows its tab if it is open already. A file that cannot be opened leaves
   *  the drop's other Markdown files to open. Resolves with the error of a
   *  file that did not open, and null otherwise. */
  private async openMarkdown(path: string): Promise<unknown> {
    try {
      await this.dependencies.files.openPath(path);
      return null;
    } catch (error) {
      console.error(`Downpad: could not open ${baseName(path)}`, error);
      return error ?? new Error("The file could not be opened.");
    }
  }

  /** Throw the error that says why no file goes into a tab's document, if it
   *  is a JSON or YAML file. A file goes in as a Markdown image or link,
   *  which would break such a file. */
  private refuseDataFile(tabId: string): void {
    const language = documentLanguage(this.tabFilePath(tabId));
    if (language !== "markdown") {
      throw new Error(`A ${LANGUAGE_NAMES[language]} file takes no dropped files. Drop them on a Markdown document.`);
    }
  }

  /** The saved path of an open tab's document, or null if it is untitled or closed. */
  private tabFilePath(tabId: string): string | null {
    return this.dependencies.store.get().tabs.find((tab) => tab.id === tabId)?.doc.filePath ?? null;
  }

  /** Save the document a drop or paste went to, if it is untitled, which
   *  asks where. Only the document in front can be saved, so for a document
   *  that is behind another tab by now, this waits until it is shown again.
   *  Resolves true once the document has a path, or false if the user
   *  cancels or the document is closed first. */
  private async saveDropDocument(drop: FileDrop): Promise<boolean> {
    if (this.tabFilePath(drop.tabId)) return true;
    if (!(await this.dependencies.editorHost.untilInFront(drop))) return false;
    return this.tabFilePath(drop.tabId) !== null || (await this.dependencies.files.save());
  }

  /** Log that a dropped or pasted file, by its name, went nowhere because its
   *  document was closed. */
  private warnNotInserted(name: string): void {
    console.warn(`Downpad: ${name} was not inserted, because its document was closed`);
  }

  /** Whether a tab is still open. */
  private hasTab(tabId: string): boolean {
    return this.dependencies.store.get().tabs.some((tab) => tab.id === tabId);
  }

  /** The document a drop or paste went to, as `storeBesideDocument` needs
   *  it: its saved path, and the wait for a Save As of it that is under way.
   *  That wait first waits for the drops and pastes into the document before
   *  this one to end (`EditorHost.untilTurn`), so the file is stored, and
   *  stored again after a Save As to another folder, only once the files
   *  before it are in. After that, the file goes in at once, or waits while
   *  the document is behind another tab, where it cannot be saved. Either
   *  way a link from its path still holds when the file goes in. */
  private dropDocument(drop: FileDrop): Pick<ImageStoreContext, "getFilePath" | "untilPathSettled"> {
    const { editorHost, files } = this.dependencies;
    return {
      getFilePath: () => this.tabFilePath(drop.tabId),
      untilPathSettled: async () => {
        await editorHost.untilTurn(drop);
        await files.untilPathSettled(drop.tabId);
      },
    };
  }

  /** Embed a dropped or pasted image, by its `name`, where its drop or paste
   *  goes in. An image stored in the attachments folder goes beside the
   *  document where it is saved as the image goes in (`resolveImageSrc`),
   *  and its URL is looked up before it goes in, so it shows from its first
   *  render (`lookUpImages`). */
  private async embedImage({ bytes, mime }: ImageBytes, drop: FileDrop, name: string): Promise<void> {
    const src = await resolveImageSrc(
      bytes,
      mime,
      {
        ...this.dropDocument(drop),
        getSettings: () => this.dependencies.store.get().settings,
        requestSave: () => this.saveDropDocument(drop),
      },
      (stored, filePath) => lookUpImages([stored], filePath),
    );
    if (src) await this.insertDropped(drop, mdImage("", src), name);
    else if (!this.hasTab(drop.tabId)) this.warnNotInserted(name);
  }

  /** Copy a dropped file into the attachments folder beside the document it
   *  was dropped on (`storeBesideDocument`), and link it where its drop goes
   *  in. */
  private async attachDroppedFile(path: string, drop: FileDrop): Promise<void> {
    // Non-image files always go to attachments (§5.7), which needs a saved doc.
    const name = baseName(path);
    if (!(await this.saveDropDocument(drop))) {
      if (!this.hasTab(drop.tabId)) this.warnNotInserted(name);
      return;
    }
    // The save can have made the document a JSON or YAML file, which gets
    // no copy of the file beside it either.
    this.refuseDataFile(drop.tabId);
    const { bytes } = await readImageBytes(path);
    const link = await storeBesideDocument(this.dropDocument(drop), async (getFilePath) => {
      const filePath = getFilePath();
      if (!filePath) return null;
      return writeAttachment(filePath, this.dependencies.store.get().settings.attachmentsFolderName, name, bytes);
    });
    if (link) await this.insertDropped(drop, mdLink(name, link), name);
    else if (!this.hasTab(drop.tabId)) this.warnNotInserted(name);
  }

  /** Insert a dropped or pasted file's Markdown into its document, once that
   *  document is in front. If the document is closed first, it gets nothing
   *  and no other document gets it instead. A copy in the attachments folder
   *  stays there. A document that was saved as a JSON or YAML file while the
   *  file was on its way takes nothing, and the file counts as left out. */
  private async insertDropped(drop: FileDrop, markdown: string, name: string): Promise<void> {
    this.refuseDataFile(drop.tabId);
    if (!(await this.dependencies.editorHost.insertDropped(drop, markdown))) this.warnNotInserted(name);
  }
}
