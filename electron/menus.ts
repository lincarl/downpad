// Native menus. Electron's undo and redo roles run Chromium's own undo, which
// knows nothing of the editors' histories: in the document and the Markdown
// source it worked once at most, and Redo never did. These menus' Undo and
// Redo ask the renderer instead, which runs the focused editor's undo or redo
// and keeps Chromium's for a plain text field.

import type { MenuItemConstructorOptions } from "electron";
import type { HistoryCommand } from "../src/ipc/bridge";

/** Undo and Redo items that call `run`, with the labels and shortcuts of
 *  Electron's undo and redo roles on `platform`. */
export function historyItems(run: (command: HistoryCommand) => void, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  return [
    { label: "Undo", accelerator: "CommandOrControl+Z", click: () => run("undo") },
    { label: "Redo", accelerator: platform === "win32" ? "Control+Y" : "Shift+CommandOrControl+Z", click: () => run("redo") },
  ];
}

/** The macOS application menu: Electron's app, Edit and Window menus, with
 *  Undo and Redo from `historyItems` in the Edit menu. The rest of the Edit
 *  menu is Electron's own for macOS. */
export function macApplicationMenu(run: (command: HistoryCommand) => void): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    {
      role: "editMenu",
      submenu: [
        ...historyItems(run, "darwin"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Substitutions",
          submenu: [
            { role: "showSubstitutions" },
            { type: "separator" },
            { role: "toggleSmartQuotes" },
            { role: "toggleSmartDashes" },
            { role: "toggleTextReplacement" },
          ],
        },
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
      ],
    },
    { role: "windowMenu" },
  ];
}
