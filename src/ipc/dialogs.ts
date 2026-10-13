import type { AskDialogOptions, OpenDialogOptions, SaveDialogOptions } from "./bridge";
import { desktopBridge } from "./bridge";
import { isElectron } from "./env";

export function openDialog(options: OpenDialogOptions): Promise<string | string[] | null> {
  return isElectron() ? desktopBridge().openDialog(options) : Promise.resolve(null);
}

export function saveDialog(options: SaveDialogOptions): Promise<string | null> {
  return isElectron() ? desktopBridge().saveDialog(options) : Promise.resolve(null);
}

export function ask(message: string, options?: AskDialogOptions): Promise<boolean> {
  return isElectron()
    ? desktopBridge().ask(message, options)
    : Promise.resolve(window.confirm(message));
}
