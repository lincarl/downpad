import { test, expect } from "@playwright/test";

// Right-click menu on a document tab (§5.19/§6.1): Open folder, Copy folder path,
// Copy file path, Close all tabs. In a plain browser the seed/new tabs are
// untitled (no path on disk), so the three path actions are disabled; "Close all
// tabs" always works. Reveal/clipboard are Electron-only and aren't exercised here.
//
// Rows are addressed by the `menuitem` role: the shared popup marks itself up as
// a real menu (role="menu" / role="menuitem") now that it also serves the custom
// right-click menu that replaced the native one (shell/contextMenu.ts).

const wysiwyg = ".milkdown .ProseMirror";
const menu = ".md-context-menu";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
});

test("right-clicking a tab shows the four-item menu", async ({ page }) => {
  await page.locator(".tab").first().click({ button: "right" });

  const m = page.locator(menu);
  await expect(m).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Copy folder path" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Close all tabs" })).toBeVisible();

  // The untitled tab has no path, so the location actions are disabled; closing
  // tabs is always available.
  await expect(m.getByRole("menuitem", { name: "Open folder" })).toBeDisabled();
  await expect(m.getByRole("menuitem", { name: "Copy folder path" })).toBeDisabled();
  await expect(m.getByRole("menuitem", { name: "Copy file path" })).toBeDisabled();
  await expect(m.getByRole("menuitem", { name: "Close all tabs" })).toBeEnabled();
});

test("'Close all tabs' closes every tab and returns to the Recent view", async ({ page }) => {
  // Open a second (untitled) tab via the "+" so there are two to close at once.
  await page.locator(".tab-new").click();
  await expect(page.locator(".tab")).toHaveCount(2);

  await page.locator(".tab").first().click({ button: "right" });
  await page.locator(menu).getByRole("menuitem", { name: "Close all tabs" }).click();

  // No tabs remain; the permanent strip keeps Recent/New available while the
  // Recent view takes over.
  await expect(page.locator(".tabstrip")).toBeVisible();
  await expect(page.locator(".recent-host")).toBeVisible();
});

test("the menu closes on Escape", async ({ page }) => {
  await page.locator(".tab").first().click({ button: "right" });
  await expect(page.locator(menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toHaveCount(0);
});
