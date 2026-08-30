import { test, expect } from "@playwright/test";

// The custom right-click menu (spec §5.14 / §6.1, shell/documentContextMenu):
// md-easy's own menu replaces the native WebView one everywhere, carries a single
// Print entry, and steps aside for Shift+right-click so WebView2's spell-check
// suggestions stay reachable.

const wysiwyg = ".milkdown .ProseMirror";
const menu = ".md-context-menu";

test("right-clicking the document opens the custom menu with the editing commands", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");

  await page.locator(`${wysiwyg} h1`).click({ button: "right" });
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(`${menu} .md-context-menu-label`)).toHaveText([
    "Cut",
    "Copy",
    "Paste",
    "Paste as plain text",
    "Insert link…",
    "Select all",
    "Copy as Markdown",
    "Print…",
  ]);
  // One Print entry, with its shortcut hint — the Document/Markdown choice is
  // made in the print workspace, not here.
  const print = page.locator(`${menu} .md-context-menu-item`, { hasText: "Print…" });
  await expect(print.locator(".md-context-menu-key")).toHaveText("Ctrl+P");
});

test("Escape closes the menu", async ({ page }) => {
  await page.goto("/");
  await page.locator(`${wysiwyg}`).click({ button: "right" });
  await expect(page.locator(menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toHaveCount(0);
});

test("Shift+right-click leaves the native menu to WebView2 (spell check, §5.14)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");

  const prevented = await page.evaluate(() => {
    const el = document.querySelector(".milkdown .ProseMirror")!;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator(menu)).toHaveCount(0);
});

test("Print in the menu opens the print workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");

  await page.locator(`${wysiwyg} h1`).click({ button: "right" });
  await page.locator(`${menu} .md-context-menu-item`, { hasText: "Print…" }).click();
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();
});
