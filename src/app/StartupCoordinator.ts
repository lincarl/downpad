// Resolves the app's initial destination without owning any visible shell UI.
// Keeping startup policy here makes AppRuntime a lifecycle coordinator rather
// than the place where recovery, launch arguments, and first-run policy live.

import { ask } from "../ipc/dialogs";
import { loadDocument } from "../document/DocumentModel";
import type { EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import {
  deleteSnapshot,
  getDefaultMdHandler,
  getLaunchArgs,
  listRecoverySnapshots,
  openDefaultAppsSettings,
} from "../ipc/commands";
import type { Snapshot } from "../ipc/contracts";
import { isElectron } from "../ipc/env";
import { RecoveryDialog } from "../recovery/RecoveryDialog";
import type { SettingsModel } from "../settings/SettingsModel";
import type { Store } from "../state/store";
import { blankDoc } from "../state/types";

export interface StartupCoordinatorDependencies {
  store: Store;
  files: FileService;
  editorHost: EditorHost;
  settings: SettingsModel;
  isDisposed(): boolean;
}

/** Implements the startup precedence from spec §5.15 and the one-time
 *  default-handler prompt from §5.12. */
export class StartupCoordinator {
  private readonly recoveryDialog = new RecoveryDialog();

  constructor(private readonly dependencies: StartupCoordinatorDependencies) {}

  dispose(): void {
    this.recoveryDialog.destroy();
  }

  /** Resolve recovery → launch argument → welcome → Recent. Returns
   *  true when startup should land in the editor. Browser/dev keeps its seed
   *  document and therefore always lands in the editor. */
  async resolve(): Promise<boolean> {
    if (this.dependencies.isDisposed()) return false;
    if (!isElectron()) return true;

    const { store } = this.dependencies;
    // The seed document is a browser/e2e convenience. The desktop app starts
    // from the real startup sources below.
    store.set({ tabs: [], activeTabId: null, doc: blankDoc() });

    if (await this.tryRecovery()) return true;
    if (this.dependencies.isDisposed()) return false;

    const arg = await getLaunchArgs().catch(() => null);
    if (this.dependencies.isDisposed()) return false;
    if (arg) {
      await this.dependencies.files
        .openPath(arg)
        .catch((error) => console.error("md-easy: open arg failed", error));
      return true;
    }

    if (!store.get().settings.hasSeenWelcome) {
      await this.loadWelcome();
      if (this.dependencies.isDisposed()) return false;
      void this.dependencies.settings.save({
        ...store.get().settings,
        hasSeenWelcome: true,
      });
      return true;
    }

    return false;
  }

  /** Offer the Windows default-app settings once, without delaying startup. */
  async maybePromptDefaultHandler(): Promise<void> {
    const { store, settings, isDisposed } = this.dependencies;
    if (isDisposed() || !isElectron() || window.mdEasy?.platform !== "win32") return;
    const current = store.get().settings;
    if (current.hasCheckedDefaultHandler) return;

    // Persist before any async work so errors or early shutdown cannot make the
    // app ask again on its next launch.
    void settings.save({ ...current, hasCheckedDefaultHandler: true });

    let isDefault: boolean;
    try {
      isDefault = (await getDefaultMdHandler()).isDefault;
    } catch (error) {
      console.error("md-easy: default-handler check failed", error);
      return;
    }
    if (isDisposed() || isDefault) return;

    const shouldOpen = await ask(
      "md-easy isn't set as the default app for Markdown (.md) files. " +
        "Open Windows settings to set it as the default?",
      {
        title: "Set md-easy as default?",
        kind: "info",
        okLabel: "Open settings",
        cancelLabel: "Not now",
      },
    ).catch(() => false);
    if (!isDisposed() && shouldOpen) await openDefaultAppsSettings().catch(() => {});
  }

  private async tryRecovery(): Promise<boolean> {
    const { store, isDisposed } = this.dependencies;
    const sessionId = store.get().sessionId;
    const snapshots = (await listRecoverySnapshots().catch(() => [])).filter(
      (snapshot) => snapshot.sessionId !== sessionId,
    );
    if (isDisposed() || snapshots.length === 0) return false;

    let loaded = false;
    await this.recoveryDialog.open(snapshots, {
      openRecovered: (snapshot) => {
        this.loadRecovered(snapshot);
        loaded = true;
      },
      openOriginal: async (snapshot) => {
        await this.openOriginalFor(snapshot);
        loaded = true;
      },
      discard: (snapshot) => void deleteSnapshot(snapshot.sessionId).catch(() => {}),
    });
    return loaded;
  }

  private loadRecovered(snapshot: Snapshot): void {
    if (this.dependencies.isDisposed()) return;
    const { editorHost, files, store } = this.dependencies;
    editorHost.flush();
    store.addTab({
      markdown: snapshot.markdown,
      filePath: snapshot.filePath,
      eol: "lf",
      hadBom: false,
      modifiedMs: 0,
      isDirty: true,
      // The snapshot holds edits, and the file may have changed since.
      savedMarkdown: null,
      frontmatterCollapsed: false,
    });
    void deleteSnapshot(snapshot.sessionId).catch(() => {});
    if (snapshot.filePath) files.watch(snapshot.filePath);
  }

  private async openOriginalFor(snapshot: Snapshot): Promise<void> {
    await deleteSnapshot(snapshot.sessionId).catch(() => {});
    if (!this.dependencies.isDisposed() && snapshot.filePath) {
      await this.dependencies.files.openPath(snapshot.filePath).catch(() => {});
    }
  }

  private async loadWelcome(): Promise<void> {
    let markdown = "# Welcome to md-easy\n\nStart typing, or open a file.\n";
    try {
      const response = await fetch("welcome.md");
      if (response.ok) markdown = await response.text();
    } catch {
      // Fall back to the inline welcome document when the asset is unavailable.
    }
    if (!this.dependencies.isDisposed()) {
      loadDocument(this.dependencies.store, markdown, {
        filePath: null,
        eol: "lf",
        hadBom: false,
      });
    }
  }
}
