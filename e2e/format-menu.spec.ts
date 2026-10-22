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

for (const { label, tag, task } of [
  { label: "Bullet List", tag: "ul", task: false },
  { label: "Ordered List", tag: "ol", task: false },
  { label: "Task List", tag: "ul", task: true },
]) {
  test(`${label} replaces an empty heading only when chosen and undo restores the heading`, async ({ page }) => {
    const editor = page.getByRole("textbox", { name: "Document editor", exact: true });
    const add = page.locator('.milkdown-block-handle[data-show="true"] > .operation-item').first();
    const menu = page.locator('.milkdown-slash-menu[data-show="true"]');
    // Crepe also mounts its virtual cursor directly inside the editor.
    const rows = editor.locator(":scope > :not(.prosemirror-virtual-cursor)");
    await editor.click();
    await page.keyboard.type("## ");
    const heading = editor.locator(":scope > h2");
    await expect(heading).toHaveText("");
    await heading.hover();
    await add.click();
    await expect(menu).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(heading).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(heading).toHaveCount(1);
    await expect(rows).toHaveCount(1);

    await heading.hover();
    await add.click();
    await menu.getByRole("option", { name: label, exact: true }).click();
    await expect(menu).toHaveCount(0);
    const list = editor.locator(`:scope > ${tag}`);
    await expect(list).toHaveCount(1);
    await expect(list.locator("li")).toHaveCount(1);
    await expect(list.locator("li p")).toHaveText("");
    await expect(list.getByRole("img", { name: "Not done", exact: true })).toHaveCount(task ? 1 : 0);
    await expect(heading).toHaveCount(0);
    // Crepe keeps a trailing paragraph after a list for continued editing.
    await expect(editor.locator(":scope > p")).toHaveCount(1);
    await expect(rows).toHaveCount(2);

    await page.keyboard.press("ControlOrMeta+z");
    await expect(heading).toHaveText("");
    await expect(rows).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(list).toHaveCount(1);
    await page.keyboard.insertText("Item");
    await expect(list.locator("li p")).toHaveText("Item");
  });
}
