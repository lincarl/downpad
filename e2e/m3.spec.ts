import { test, expect, type Page } from "@playwright/test";

// Frontmatter table and settings behaviour that needs a real browser's CSS:
// hover reveals, the document's side padding and the document theme. The
// table's edits and the settings model are unit tests in src/.

const wysiwyg = ".milkdown .ProseMirror";
// The visible WYSIWYG editor body (hidden panes stay alive to preserve undo, §5.19).
const liveWysiwyg = ".editor-pane:not([hidden]) .ProseMirror";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
});

/** Open the sample's disclosure before exercising its editable fields. */
async function expandFrontmatter(page: Page): Promise<void> {
  const toggle = page.locator(".editor-pane-wysiwyg:not([hidden]) .frontmatter-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

// Opens Settings on the given page. The dialog keeps one page visible at a time
// (General first), so a field must be reached through its nav row.
async function openSettings(page: Page, section = "General"): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".dialog").getByRole("tab", { name: section, exact: true }).click();
}

test("an inserter '+' is revealed only by hovering THAT gap, not by hovering a row", async ({
  page,
}) => {
  await expandFrontmatter(page);
  const gapBtn = page.locator(".frontmatter-inserter-btn").nth(1);
  await expect(gapBtn).toHaveCSS("opacity", "0");

  // Hovering a data row must NOT reveal its adjacent gap "+".
  await page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "tags", exact: true }) })
    .hover();
  await expect(gapBtn).toHaveCSS("opacity", "0");

  // Hovering the gap (the "+" itself) reveals exactly that one.
  await gapBtn.hover();
  await expect(gapBtn).toHaveCSS("opacity", "1");
});

test("a fixed page width below 688px narrows the document's side padding in a wide window", async ({
  page,
}) => {
  // The padding follows the editor's own width, so a narrow page narrows it
  // whatever the window's size (docs/spec.md, Appearance and preferences).
  await page.setViewportSize({ width: 1400, height: 720 });
  const editor = page.locator(liveWysiwyg);
  const setPageWidth = async (width: string) => {
    await openSettings(page, "Appearance");
    const dialog = page.locator(".dialog");
    await dialog.locator(".dialog-row", { hasText: "Fixed width" }).locator("input").fill(width);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
  };

  await setPageWidth("688");
  await expect(editor).toHaveCSS("padding-left", "120px");

  await setPageWidth("600");
  await expect(editor).toHaveCSS("padding-left", "76px");
  await expect(editor).toHaveCSS("padding-right", "76px");
  const column = await editor.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  expect(column).toBe(400);
});

test("the toolbar theme button changes the document without changing the UI", async ({ page }) => {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-editor-theme", "light");

  await page.getByRole("button", { name: "Switch to dark document theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-editor-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Switch to light document theme" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Switch to light document theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-editor-theme", "light");
});
