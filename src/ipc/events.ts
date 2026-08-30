// Typed wrappers over Tauri's event listeners (Rust -> frontend). See docs/design.md §3.3.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Settings } from "../state/types";
import type { PrintCompleted } from "./contracts";

/** Fired by the settings.toml watcher when the file changes on disk (§5.9). */
export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>("settings-changed", (event) => handler(event.payload));
}

export interface FileChangedPayload {
  path: string;
  modifiedMs: number;
}

/** Fired by the file watcher when the open file changes on disk (§5.1). */
export function onFileChanged(handler: (payload: FileChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FileChangedPayload>("file-changed", (event) => handler(event.payload));
}

/** Fired by the single-instance plugin when a 2nd launch opens a .md (§5.12). */
export function onOpenFileRequested(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>("open-file-requested", (event) => handler(event.payload.path));
}

/** Fired when a native print / print-to-PDF run finishes or fails (§5.21). */
export function onPrintCompleted(handler: (result: PrintCompleted) => void): Promise<UnlistenFn> {
  return listen<PrintCompleted>("print-completed", (event) => handler(event.payload));
}
