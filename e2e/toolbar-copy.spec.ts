import { expect, test, type Page } from "@playwright/test";

// The toolbar's responsive layout and the copy error banner. The copied
// content itself runs in e2e-electron/desktop.spec.ts and
// src/clipboard/formattedDocument.test.ts.

/** Choose a whole-document copy format from the main toolbar. */
async function copy(page: Page, format: string): Promise<void> {
  await page.locator(".toolbar").getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("menuitem", { name: format, exact: true }).click();
  await expect(page.getByRole("menu", { name: "Copy", exact: true })).toBeHidden();
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator(".ProseMirror h1")).toContainText("Welcome to Downpad");
});

test("Settings stays at the right edge across toolbar breakpoints, and its General page fits a narrow window", async ({ page }) => {
  const toolbar = page.locator(".toolbar");
  const settings = toolbar.getByRole("button", { name: "Settings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  for (const width of [1000, 976, 975, 860, 859, 770, 769, 700, 699, 661, 660, 621, 480]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = (await settings.boundingBox())!;
    expect(bounds.x + bounds.width, `Settings at ${width}px`).toBeLessThanOrEqual(width);
    expect(bounds.x + bounds.width, `Settings at ${width}px`).toBeGreaterThan(width - 10);
    // At the narrowest width the General page still fits every field.
    if (width !== 480) continue;
    await settings.click();
    const fits = await dialog.getByRole("tabpanel", { name: "General" }).evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll("input, select")].every((control) => control.getBoundingClientRect().right <= right);
    });
    expect(fits, `General settings fit at ${width}px`).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
  }
  // At the minimum width Copy still comes before Print.
  const copyButton = (await toolbar.getByRole("button", { name: "Copy", exact: true }).boundingBox())!;
  const print = (await toolbar.getByRole("button", { name: "Print", exact: true }).boundingBox())!;
  expect(copyButton.x).toBeLessThan(print.x);
});

test("a denied formatted copy reports the failure", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "write", {
      value: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    });
  });
  await copy(page, "Copy formatted text");
  await expect(page.getByRole("alert")).toContainText(/copy/i);
});
