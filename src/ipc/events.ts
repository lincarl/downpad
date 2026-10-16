// Typed Electron main-process events. See docs/design.md §3.3.

import { desktopBridge, type HistoryCommand } from "./bridge";
import type { Settings } from "../state/types";
import type { PrintCompleted } from "./contracts";

type UnlistenFn = () => void;

/** Fired by the settings.toml watcher when the file changes on disk (§5.9). */
export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("settings-changed", handler));
}

export interface FileChangedPayload {
  path: string;
  modifiedMs: number;
}

/** Fired by the file watcher when the open file changes on disk (§5.1). */
export function onFileChanged(handler: (payload: FileChangedPayload) => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("file-changed", handler));
}

/** Fired when a second app launch opens a Markdown file (§5.12). */
export function onOpenFileRequested(handler: (path: string) => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("open-file-requested", (event) => handler(event.path)));
}

/** Fired when a native print / print-to-PDF run finishes or fails (§5.21). */
export function onPrintCompleted(handler: (result: PrintCompleted) => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("print-completed", handler));
}

/** Fired when Undo or Redo is chosen in a native menu: the spell-check menu
 *  or, on macOS, the Edit menu. */
export function onHistoryRequested(handler: (command: HistoryCommand) => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("history-requested", handler));
}

/** The main process delays closing until the renderer confirms unsaved edits. */
export function onCloseRequested(handler: () => void): Promise<UnlistenFn> {
  return Promise.resolve(desktopBridge().listen("close-requested", handler));
}
