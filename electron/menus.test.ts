import { expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { historyItems, macApplicationMenu } from "./menus";

/** The labels or roles of `items`, as a menu shows them. */
const names = (items: MenuItemConstructorOptions[]) => items.map((item) => item.label ?? item.role ?? item.type);

it.each([
  ["win32", "Control+Y"],
  ["linux", "Shift+CommandOrControl+Z"],
  ["darwin", "Shift+CommandOrControl+Z"],
] as const)("Undo and Redo on %s ask the renderer and keep the role's shortcuts", (platform, redo) => {
  const asked: string[] = [];
  const items = historyItems((command) => asked.push(command), platform);
  for (const item of items) Reflect.apply(item.click!, undefined, []);
  expect(asked).toEqual(["undo", "redo"]);
  // A role would run Chromium's own undo and ignore the click.
  expect(items.map(({ role, accelerator }) => [role, accelerator])).toEqual([
    [undefined, "CommandOrControl+Z"],
    [undefined, redo],
  ]);
});

it("the macOS Edit menu asks the renderer for Undo and Redo and keeps Electron's other items", () => {
  const menu = macApplicationMenu(() => {});
  expect(names(menu)).toEqual(["appMenu", "editMenu", "windowMenu"]);
  const edit = menu[1].submenu as MenuItemConstructorOptions[];
  expect(names(edit)).toEqual([
    "Undo", "Redo", "separator", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "separator",
    "Substitutions", "Speech",
  ]);
  expect(edit.slice(0, 2).every((item) => item.role === undefined && item.click)).toBe(true);
});
