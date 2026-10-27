// React-backed compatibility controller for the in-app Settings dialog. The
// shell keeps the stable open/close/isOpen API while React and Radix/shadcn own
// the modal form and its lifecycle.

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Store } from "../state/store";
import type { Settings } from "../state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialogView } from "./SettingsDialogView";
import { disposeReactRoot } from "../app/disposeReactRoot";
import { captureFocus } from "../app/restoreFocus";

export class SettingsDialog {
  private root: Root | null = null;
  private host: HTMLElement | null = null;
  private restoreFocus: (() => void) | null = null;

  /** `restartIfSaved` restarts Downpad to install a downloaded update if no
   *  document has unsaved changes, and resolves false otherwise. */
  constructor(
    private readonly store: Store,
    private readonly onSave: (next: Settings) => void,
    private readonly restartIfSaved?: () => Promise<boolean>,
  ) {}

  isOpen(): boolean {
    return this.root !== null;
  }

  open(): void {
    if (this.root) return;

    // Older settings files may omit newer fields. Merge them over the defaults
    // once per opening so every control has a finite staged value.
    const initial: Settings = { ...DEFAULT_SETTINGS, ...this.store.get().settings };
    this.restoreFocus = captureFocus();
    const host = document.createElement("div");
    host.className = "settings-dialog-root";
    document.body.appendChild(host);

    const root = createRoot(host);
    this.host = host;
    this.root = root;
    // Match the legacy synchronous contract: callers can query `.dialog`
    // immediately after open() returns.
    flushSync(() => {
      root.render(
        createElement(SettingsDialogView, {
          initial,
          onSave: this.onSave,
          onRequestClose: () => this.close(),
          restartIfSaved: this.restartIfSaved,
        }),
      );
    });
  }

  close(): void {
    const root = this.root;
    const host = this.host;
    if (!root) return;

    // Clear first so a close callback cannot observe stale open state or attempt
    // to unmount this root twice.
    this.root = null;
    this.host = null;
    disposeReactRoot(root, host);
    this.restoreFocus?.();
    this.restoreFocus = null;
  }
}

export { SettingsDialogView } from "./SettingsDialogView";
