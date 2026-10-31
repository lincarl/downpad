import { test, expect } from "@playwright/test";

// Regression test for the spurious "unsaved changes" bug: opening a document and
// merely opening/closing the Markdown split must NOT mark a never-edited document
// dirty. Opening the split builds the raw pane and the toggle flushes the document
// view. Milkdown would write the text another way (list markers, table padding,
// …), but the document view reports the exact source until the user edits it, so
// the flush is a no-op.
//
// Dirty state appears as a red document icon in the tab strip (TabStrip).
// The window title stays unchanged even when the document has unsaved edits.

const wysiwyg = ".milkdown .ProseMirror";
const rawContent = ".editor-pane-raw .cm-content";
const splitSeg = ".toolbar-view button:has-text('Split')";
const documentSeg = ".toolbar-view button:has-text('Document')";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
});

test("a freshly opened document is not dirty, even after opening/closing the split", async ({
  page,
}) => {
  // Clean on load, with no unsaved document icons.
  await expect(page).not.toHaveTitle(/^●/);
  await expect(page.locator(".tab-file-icon.is-dirty")).toHaveCount(0);

  // Open the Markdown split ("Split"), then return to the document ("Document").
  // Each layout switch flushes the document through the round-trip that used to
  // spuriously dirty the doc.
  await page.locator(splitSeg).click();
  await expect(page.locator(rawContent)).toBeVisible();
  await page.locator(documentSeg).click();
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");

  // Still clean — opening the split with no edits must never raise the unsaved flag.
  await expect(page).not.toHaveTitle(/^●/);
  await expect(page.locator(".tab-file-icon.is-dirty")).toHaveCount(0);
});
