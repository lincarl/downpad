import { test, expect, type Page } from "@playwright/test";

const documentBody = ".editor-pane-wysiwyg:not([hidden]) .ProseMirror";

/** Put source and optional highlighted HTML on the real browser clipboard. */
async function pasteMarkdown(page: Page, markdown: string, html?: string): Promise<void> {
  await page.evaluate(async ({ markdown, html }) => {
    const types: Record<string, Blob> = { "text/plain": new Blob([markdown], { type: "text/plain" }) };
    if (html) types["text/html"] = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(types)]);
  }, { markdown, html });
  await page.keyboard.press("ControlOrMeta+V");
}

/** Copy the complete source from the Markdown pane without its DOM decorations. */
async function source(page: Page): Promise<string> {
  await page.locator(".toolbar-view button:has-text('Markdown')").click();
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  return page.evaluate(() => navigator.clipboard.readText());
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator(`${documentBody} h1`)).toContainText("Welcome to Downpad");
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.locator(documentBody).click();
});

test("pasting a Markdown document preserves frontmatter and exact source across undo and view switches", async ({ page }) => {
  const markdown = '---\ntitle: "Clipboard document"\ntags: [one, two]\n---\n\n\n# Heading\n\n* original bullet\n\nSee [guide][ref].\n\n[ref]: https://example.test\n';
  await pasteMarkdown(page, markdown, `<pre><code>${markdown}</code></pre>`);
  await expect(page.locator(`${documentBody} h1`)).toHaveText("Heading");
  const frontmatter = page.locator(".editor-pane-wysiwyg:not([hidden]) .frontmatter-toggle");
  await expect(frontmatter).toBeVisible();
  await expect(page.locator(documentBody)).not.toContainText("title:");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(frontmatter).toHaveCount(0);
  await expect(page.locator(documentBody)).toHaveText("");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(frontmatter).toBeVisible();
  expect(await source(page)).toBe(markdown);
  await page.locator(".toolbar-view button:has-text('Document')").click();
  await expect(page.locator(`${documentBody} h1`)).toHaveText("Heading");
  expect(await source(page)).toBe(markdown);
});

test("pasting Markdown replaces the selected text and leaves typing after it", async ({ page }) => {
  await page.keyboard.insertText("Before target after.");
  await page.keyboard.press("Home");
  for (let index = 0; index < 7; index++) await page.keyboard.press("ArrowRight");
  for (let index = 0; index < 6; index++) await page.keyboard.press("Shift+ArrowRight");
  await pasteMarkdown(page, "__new__");
  await expect(page.locator(`${documentBody} strong`)).toHaveText("new");
  await page.keyboard.insertText("!");
  await expect(page.locator(documentBody)).toHaveText("Before new! after.");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(page.locator(documentBody)).toHaveText("Before new after.");
  expect(await source(page)).toBe("Before __new__ after.\n");
});

test("pastes stay literal inside inline code and fenced code", async ({ page }) => {
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.insertText("Before `left target right` after.\n\n```text\nold code\n```\n");
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  const inlineCode = page.locator(`${documentBody} > p code`);
  await inlineCode.click();
  await inlineCode.evaluate((code) => {
    const text = code.firstChild!;
    document.getSelection()?.setBaseAndExtent(text, 5, text, 11);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("target");
  await pasteMarkdown(page, "**bold** `code`");
  await expect(inlineCode).toHaveText("left **bold** `code` right");
  const code = page.locator(`${documentBody} .cm-content`);
  await code.click();
  await page.keyboard.press("ControlOrMeta+A");
  await pasteMarkdown(page, "---\ntitle: literal\n---\n\n# Still code\n");
  await expect(code).toContainText("# Still code");
  await expect(page.locator(`${documentBody} h1`)).toHaveCount(0);
  await expect(page.locator(".editor-pane-wysiwyg:not([hidden]) .frontmatter-toggle")).toHaveCount(0);
  expect(await source(page)).toContain("Before ``left **bold** `code` right`` after.");
});

test("pasting repeated or nested formatting preserves surrounding marks and the insertion endpoint", async ({ page }) => {
  await pasteMarkdown(page, "Before **left target right** after.");
  const strong = page.locator(`${documentBody} strong`);
  await strong.evaluate((element) => {
    const text = element.firstChild!;
    document.getSelection()?.setBaseAndExtent(text, 5, text, 11);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("target");
  await pasteMarkdown(page, "**new**");
  await expect(strong).toHaveText("left new right");
  await page.keyboard.insertText("!");
  await expect(strong).toHaveText("left new! right");

  await page.keyboard.press("ControlOrMeta+A");
  await pasteMarkdown(page, "Before target after.");
  await page.keyboard.press("Home");
  for (let index = 0; index < 7; index++) await page.keyboard.press("ArrowRight");
  for (let index = 0; index < 6; index++) await page.keyboard.press("Shift+ArrowRight");
  await pasteMarkdown(page, "target **after**.");
  await page.keyboard.insertText("!");
  await expect(page.locator(documentBody)).toHaveText("Before target after.! after.");
});
