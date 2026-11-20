// Copy file (spec, Core experience) puts a file on the clipboard as the
// system's file manager copies it, so it can be pasted into a folder, or into
// an email or chat as an attachment.
//
// Electron writes `text/uri-list` as the system's list of copied files:
// CF_HDROP on Windows, file URLs on macOS and `text/uri-list` on Linux.
// File managers on Linux built with GTK, such as Files, Nemo and Thunar,
// paste their own `x-special/gnome-copied-files` list, so Linux gets that too.

import { clipboard, ClipboardItem } from "electron";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The clipboard formats that copy the file at `path` on `platform`, as an
 *  Electron `ClipboardItem` takes them. `path` follows the platform's path
 *  rules, such as `C:\Users\…` or a `\\server\share` path on Windows. */
export function fileClipboardEntries(path: string, platform: NodeJS.Platform): Record<string, string> {
  const url = pathToFileURL(path, { windows: platform === "win32" }).href;
  const entries: Record<string, string> = { "text/uri-list": url };
  if (platform === "linux") entries['electron application/osclipboard;format="x-special/gnome-copied-files"'] = `copy\n${url}`;
  return entries;
}

/** Put the file at `path` on the clipboard as copied files. Throws when
 *  `path` is not a file. The renderer asks for one copy at a time
 *  (`src/app/copyFile.ts`), so a slow look at one file cannot put it on the
 *  clipboard after a file copied later. */
export async function copyFileToClipboard(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error("Only a file can be copied.");
  await clipboard.write([new ClipboardItem(fileClipboardEntries(path, process.platform))]);
}
