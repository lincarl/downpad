import { test, expect } from "@playwright/test";

// This file checks the view control (§6.1) in a real browser, where real undo
// must survive a trip through the split. The layouts, the split mirror, the
// narrow split's padding and the find card's focus are unit tests in src/ or
// run in e2e-electron.

const wysiwyg = ".milkdown .ProseMirror";
// In the split, BOTH panes are visible, and the document pane's embedded code
// blocks are also `.cm-content`, so scope the raw source to its own pane.
const rawContent = ".editor-pane-raw .cm-content";
const documentSeg = ".toolbar-view button:has-text('Document')";
const splitSeg = ".toolbar-view button:has-text('Split')";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // WYSIWYG mounts asynchronously; wait for the seeded heading to render.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
});

test("opening then closing the split preserves the document's undo history", async ({ page }) => {
  const doc = page.locator(wysiwyg);
  // The text of every block but code blocks, whose fold markers CodeMirror
  // draws once their language loads, which can be after this test starts.
  const text = () => doc.evaluate((element) =>
    Array.from(element.children, (block) => (block.matches(".milkdown-code-block") ? "" : block.textContent)).join("\n"));
  const before = await text();
  await doc.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" zzundomarker");
  await expect.poll(text).toContain("zzundomarker");

  // The split keeps the same document editor, so its undo history survives.
  await page.locator(splitSeg).click();
  await expect(page.locator(rawContent)).toBeVisible();
  await page.locator(documentSeg).click();
  await expect(page.locator(rawContent)).toBeHidden();

  await doc.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).toBe(before);
});
