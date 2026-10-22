import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Document editor", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New document", exact: true }).click();
});

test("the selection toolbar puts H1 through H4 first and converts the selected text", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "Document editor", exact: true });
  await editor.click();
  await page.keyboard.insertText("Section title");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const toolbar = page.locator('.milkdown-toolbar[data-show="true"]');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator("button")).toHaveText(["H1", "H2", "H3", "H4", "", "", "", "", ""]);
  await expect(toolbar.getByRole("button", { name: "Inline math", exact: true })).toHaveCount(0);
  for (const level of [1, 2, 3, 4]) {
    const button = toolbar.getByRole("button", { name: `Heading ${level}`, exact: true });
    await button.click();
    await expect(editor.locator(`h${level}`)).toHaveText("Section title");
    await expect(button).toHaveClass(/active/);
  }
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("#### Section title");
});

test("the empty-row plus opens the block menu in place and nonempty rows still insert after", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "Document editor", exact: true });
  const add = page.locator('.milkdown-block-handle[data-show="true"] > .operation-item').first();
  const menu = page.locator('.milkdown-slash-menu[data-show="true"]');
  const empty = editor.locator(":scope > p");
  await empty.click();
  await empty.hover();
  await add.click();
  await expect(menu).toBeVisible();
  await expect(editor.locator(":scope > p")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor.locator(":scope > p")).toHaveCount(1);
  await empty.hover();
  await add.click();
  await menu.getByRole("option", { name: "Heading 2", exact: true }).click();
  await expect(editor.locator(":scope > h2")).toHaveCount(1);
  await expect(editor.locator(":scope > p")).toHaveCount(0);
  await page.keyboard.insertText("Section title");
  await editor.locator("h2").hover();
  await add.click();
  await expect(menu).toBeVisible();
  await expect(editor.locator(":scope > h2")).toHaveText("Section title");
  await expect(editor.locator(":scope > p")).toHaveCount(1);
});
