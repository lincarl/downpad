import { expect, test, type Page } from "@playwright/test";

/** Enter source through the Markdown pane, then show its document rendering. */
async function setSource(page: Page, markdown: string): Promise<void> {
  await page.locator(".toolbar-view").getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(markdown);
  await page.locator(".toolbar-view").getByRole("radio", { name: "Document", exact: true }).click();
}

test("a diagram redraws in place when the invalid source in its code block is corrected", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".ProseMirror h1")).toContainText("Welcome to Downpad");
  await setSource(page, '```mermaid\ngraph LR\nA["unfinished\n```\n');
  const block = page.locator(".editor-pane-wysiwyg .milkdown-code-block");
  await expect(block).toHaveCount(1);
  await expect(block.locator(".mermaid-error")).toBeVisible();
  const original = await block.elementHandle();
  // Finish the label in the block's own code editor, so the same block redraws.
  await block.locator(".cm-line", { hasText: 'A["unfinished' }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText('"]');
  await expect(block.locator(".mermaid-error")).toHaveCount(0);
  await expect(block.locator("svg.pele")).toBeVisible();
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
});
