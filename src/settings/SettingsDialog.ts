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

  /** Open Settings with the current preferences and a save handler, which
   *  resolves false when the settings could not be written. */
  constructor(
    private readonly store: Store,
    private readonly onSave: (next: Settings) => Promise<boolean>,
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
          // The changes go onto the settings as they are when saved, so a
          // change made meanwhile, such as in settings.toml, stays.
          onSave: (changes) => this.onSave({ ...DEFAULT_SETTINGS, ...this.store.get().settings, ...changes }),
          // A save that ends after this dialog closed leaves the next one open.
          onRequestClose: () => {
            if (this.root === root) this.close();
          },
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
