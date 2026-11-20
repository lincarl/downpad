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

/** Counts the copies asked for, so that the one asked for last wins. */
let asked = 0;

/** Put the file at `path` on the clipboard as copied files. Throws when
 *  `path` is not a file. A copy asked for while this one still looks at its
 *  file takes its place, so a slow look, as on a network drive that went
 *  away, neither holds a later copy up nor puts its file on the clipboard
 *  after that one's, and the copy that was replaced resolves without an
 *  error. */
export async function copyFileToClipboard(path: string): Promise<void> {
  const mine = ++asked;
  // A look that fails counts as "not a file" only for the copy asked for
  // last. One that another copy replaced ends quietly, so its late error
  // does not show while the later file is on the clipboard.
  const isFile = await stat(path).then((info) => info.isFile(), (error: unknown) => {
    if (mine !== asked) return null;
    throw error;
  });
  if (mine !== asked || isFile === null) return;
  if (!isFile) throw new Error("Only a file can be copied.");
  await clipboard.write([new ClipboardItem(fileClipboardEntries(path, process.platform))]);
}
