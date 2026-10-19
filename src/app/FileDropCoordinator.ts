// Files dropped from the desktop (spec §5.4). Each dropped Markdown file opens
// in a tab. Other dropped files go into the document they were dropped on, an
// image as an image and any other file as a link to its copy in the
// attachments folder. EditorHost decides where in that document each file
// goes, and holds a file back while its document is behind another tab. A
// file that cannot be read or stored is left out, and the drop's other files
// still go in.

import type { DropPoint, EditorHost, FileDrop } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { resolveImageSrc } from "../images/imageStore";
import { rebaseLink } from "../images/pathResolve";
import { readImageBytes, writeAttachment } from "../ipc/commands";
import { baseName, classifyDrop } from "../paste/dropHandler";
import { mdImage, mdLink } from "../paste/mdLink";
import type { Store } from "../state/store";

export interface FileDropDependencies {
  store: Store;
  files: Pick<FileService, "newDocument" | "openPath" | "save">;
  editorHost: Pick<EditorHost, "aimDrop" | "insertDropped" | "releaseDrop" | "untilInFront">;
  /** Show the active tab's document in the editor, leaving the Recent view. */
  showActiveDoc(): Promise<void>;
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
   * logged and left out, and the others still go in. A file only goes into
   * the document in front, so those files go in first and the Markdown files
   * open once they are in. A new tab would otherwise put the document behind
   * it while they are read. If the document goes behind another tab before
   * then, its files wait until it is shown again, and the Markdown files open
   * at once rather than wait with them. Call this while handling the drop
   * event, because it reads where the files go from `point` before it first
   * awaits.
   */
  async handle(paths: string[], point: DropPoint): Promise<void> {
    const markdown = paths.filter((path) => classifyDrop(path) === "md");
    const others = paths.filter((path) => classifyDrop(path) !== "md");
    let inserted: Promise<void> = Promise.resolve();
    try {
      const drop = others.length > 0 ? await this.aim(point) : null;
      if (drop) {
        inserted = this.insertFiles(others, drop);
        await this.untilInsertedOrBehind(inserted, drop.tabId);
      }
    } finally {
      for (const path of markdown) await this.openMarkdown(path);
    }
    await inserted;
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
    let drop: FileDrop | null = null;
    if (!activeTabId) await files.newDocument();
    else if (view === "recent") await this.dependencies.showActiveDoc();
    else drop = editorHost.aimDrop(point);
    return drop ?? editorHost.aimDrop();
  }

  /** Put a drop's files that are not Markdown files into the document they
   *  were dropped on, in the order they were dropped, and end the drop. A
   *  file that cannot be read or stored, such as one deleted since the drop,
   *  is logged and left out, and the files after it still go in. */
  private async insertFiles(paths: string[], drop: FileDrop): Promise<void> {
    try {
      for (const path of paths) {
        try {
          if (classifyDrop(path) === "image") await this.embedDroppedImage(path, drop);
          else await this.attachDroppedFile(path, drop);
        } catch (error) {
          console.error(`md-easy: could not insert ${baseName(path)}`, error);
        }
      }
    } finally {
      this.dependencies.editorHost.releaseDrop(drop);
    }
  }

  /** Resolve once a drop's files are in, or once the document they were
   *  dropped on is no longer in front, whichever comes first. A new tab can
   *  no longer put that document behind it then, and its files wait for it
   *  anyway. */
  private async untilInsertedOrBehind(inserted: Promise<void>, tabId: string): Promise<void> {
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
   *  the drop's other Markdown files to open. */
  private async openMarkdown(path: string): Promise<void> {
    try {
      await this.dependencies.files.openPath(path);
    } catch (error) {
      console.error(`md-easy: could not open ${baseName(path)}`, error);
    }
  }

  /** The saved path of an open tab's document, or null if it is untitled or closed. */
  private tabFilePath(tabId: string): string | null {
    return this.dependencies.store.get().tabs.find((tab) => tab.id === tabId)?.doc.filePath ?? null;
  }

  /** Save the document a drop went to, if it is untitled, which asks where.
   *  Only the document in front can be saved, so for a drop on a document
   *  that is behind another tab by now, this waits until that document is
   *  shown again. Resolves true once the document has a path, or false if the
   *  user cancels or the document is closed first. */
  private async saveDropDocument(drop: FileDrop): Promise<boolean> {
    if (this.tabFilePath(drop.tabId)) return true;
    if (!(await this.dependencies.editorHost.untilInFront(drop))) return false;
    return this.tabFilePath(drop.tabId) !== null || (await this.dependencies.files.save());
  }

  /** Log that a dropped file went nowhere because its document was closed. */
  private warnNotInserted(path: string): void {
    console.warn(`md-easy: ${baseName(path)} was not inserted, because the document it was dropped on was closed`);
  }

  /** Whether a tab is still open. */
  private hasTab(tabId: string): boolean {
    return this.dependencies.store.get().tabs.some((tab) => tab.id === tabId);
  }

  /** Embed a dropped image where its drop goes in. An image stored in the
   *  attachments folder goes beside the document as it is once the image is
   *  read, or once it is saved, if the image asked for that. */
  private async embedDroppedImage(path: string, drop: FileDrop): Promise<void> {
    const { bytes, mime } = await readImageBytes(path);
    // The store asks for the path right before it writes the image, so the
    // last path it got is the one an attachment's link is relative to.
    let storedBeside: string | null = null;
    const src = await resolveImageSrc(bytes, mime, {
      getSettings: () => this.dependencies.store.get().settings,
      getFilePath: () => (storedBeside = this.tabFilePath(drop.tabId)),
      requestSave: () => this.saveDropDocument(drop),
    });
    if (src) await this.insertDropped(drop, () => mdImage("", this.linkFromDocument(drop, storedBeside, src)), path);
    else if (!this.hasTab(drop.tabId)) this.warnNotInserted(path);
  }

  /** Copy a dropped file into the attachments folder beside the document it
   *  was dropped on, and link it where its drop goes in. */
  private async attachDroppedFile(path: string, drop: FileDrop): Promise<void> {
    // Non-image files always go to attachments (§5.7), which needs a saved doc.
    if (!(await this.saveDropDocument(drop))) {
      if (!this.hasTab(drop.tabId)) this.warnNotInserted(path);
      return;
    }
    const { bytes } = await readImageBytes(path);
    // The user may have saved the document in another folder during the
    // read, so the copy goes beside the document as it is now.
    const filePath = this.tabFilePath(drop.tabId);
    if (!filePath) {
      if (!this.hasTab(drop.tabId)) this.warnNotInserted(path);
      return;
    }
    const name = baseName(path);
    const link = await writeAttachment(
      filePath,
      this.dependencies.store.get().settings.attachmentsFolderName,
      name,
      bytes,
    );
    await this.insertDropped(drop, () => mdLink(name, this.linkFromDocument(drop, filePath, link)), path);
  }

  /** The link to a dropped file from the document it was dropped on, as that
   *  document is saved now. `link` names the file from the document saved at
   *  `linkedFrom`, beside which the file was written. A document saved in
   *  another folder since then links back to the file there. A data URI, or
   *  a link without `linkedFrom`, stays as it is. */
  private linkFromDocument(drop: FileDrop, linkedFrom: string | null, link: string): string {
    const filePath = this.tabFilePath(drop.tabId);
    return linkedFrom && filePath ? rebaseLink(link, linkedFrom, filePath) : link;
  }

  /** Insert a dropped file's Markdown into the document it was dropped on,
   *  once that document is in front. The Markdown comes from `markdown` right
   *  as it goes in. If the document is closed first, it gets nothing and no
   *  other document gets it instead. A copy in the attachments folder stays
   *  there. */
  private async insertDropped(drop: FileDrop, markdown: () => string, path: string): Promise<void> {
    if (!(await this.dependencies.editorHost.insertDropped(drop, markdown))) this.warnNotInserted(path);
  }
}
