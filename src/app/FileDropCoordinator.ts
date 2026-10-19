// Files dropped from the desktop (spec §5.4). A dropped Markdown file opens in
// a tab. Other dropped files go into the document they were dropped on, an
// image as an image and any other file as a link to its copy in the
// attachments folder. EditorHost decides where in that document each file
// goes, and holds a file back while its document is behind another tab.

import type { DropPoint, EditorHost, FileDrop } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { resolveImageSrc, type ImageStoreContext } from "../images/imageStore";
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
   * Handle the files of one drop: a markdown file opens (honoring the unsaved
   * guard); image files embed where they were dropped on the document, or at
   * the cursor; other files are copied into the attachments folder and linked
   * the same way. The files go into the document they were dropped on. If
   * another tab is in front by the time a file is read, the file waits until
   * that document is shown again. Call it while handling the drop event,
   * because it reads where the files go from `point` before it first awaits.
   */
  async handle(paths: string[], point: DropPoint): Promise<void> {
    const { store, files, editorHost } = this.dependencies;
    // A dropped markdown file opens in its own tab (§5.19).
    const md = paths.find((p) => classifyDrop(p) === "md");
    if (md) {
      await files.openPath(md);
      return;
    }
    // Aim now, during the drop event, while the drop point is over the text the
    // file was dropped on. Reading the file comes after. With no document open,
    // create one first so the drop has somewhere to go, and from the Recent
    // view show the document. The files then go in at its caret.
    const { activeTabId, view } = store.get();
    let drop: FileDrop | null = null;
    if (!activeTabId) await files.newDocument();
    else if (view === "recent") await this.dependencies.showActiveDoc();
    else drop = editorHost.aimDrop(point);
    drop ??= editorHost.aimDrop();
    if (!drop) return;
    try {
      for (const path of paths) {
        if (classifyDrop(path) === "image") await this.embedDroppedImage(path, drop);
        else await this.attachDroppedFile(path, drop);
      }
    } finally {
      editorHost.releaseDrop(drop);
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

  /** Context for storing a dropped image, with the path of the document it
   *  was dropped on. */
  private dropImageContext(drop: FileDrop): ImageStoreContext {
    return {
      getSettings: () => this.dependencies.store.get().settings,
      getFilePath: () => this.tabFilePath(drop.tabId),
      requestSave: () => this.saveDropDocument(drop),
    };
  }

  /** Embed a dropped image where its drop goes in. */
  private async embedDroppedImage(path: string, drop: FileDrop): Promise<void> {
    const { bytes, mime } = await readImageBytes(path);
    const src = await resolveImageSrc(bytes, mime, this.dropImageContext(drop));
    if (src) await this.insertDropped(drop, mdImage("", src), path);
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
    const filePath = this.tabFilePath(drop.tabId);
    if (!filePath) return;
    const { bytes } = await readImageBytes(path);
    const name = baseName(path);
    const rel = await writeAttachment(
      filePath,
      this.dependencies.store.get().settings.attachmentsFolderName,
      name,
      bytes,
    );
    await this.insertDropped(drop, mdLink(name, rel), path);
  }

  /** Insert a dropped file's Markdown into the document it was dropped on,
   *  once that document is in front. If the document is closed first, it gets
   *  nothing and no other document gets it instead. A copy in the attachments
   *  folder stays there. */
  private async insertDropped(drop: FileDrop, markdown: string, path: string): Promise<void> {
    if (!(await this.dependencies.editorHost.insertDropped(drop, markdown))) this.warnNotInserted(path);
  }
}
