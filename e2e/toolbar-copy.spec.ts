import { expect, test, type Page } from "@playwright/test";

const markdown = "# Copy check\n\nA **bold** and *italic* [link](https://example.com).\n\n- First item\n- Second item\n\n```js\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Sample | 42 |\n";

/** Replace the document through the source editor, keeping the last edit pending. */
async function enterMarkdown(page: Page): Promise<void> {
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(markdown);
}

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

test("Markdown copy includes the latest source edits without changing the document", async ({ page }) => {
  await enterMarkdown(page);
  await copy(page, "Copy as markdown");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("const answer = 42;");
});

for (const layout of ["Document", "Split", "Markdown"]) {
  test(`formatted copy provides rich and plain text in ${layout} view`, async ({ page }) => {
    await enterMarkdown(page);
    if (layout !== "Markdown") await page.getByRole("radio", { name: layout, exact: true }).click();
    await copy(page, "Copy formatted text");
    await expect.poll(() => page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const rich = items.find((item) => item.types.includes("text/html"));
      if (!rich) return null;
      const html = new DOMParser().parseFromString(await (await rich.getType("text/html")).text(), "text/html");
      const text = await (await rich.getType("text/plain")).text();
      return {
        heading: html.querySelector("h1")?.textContent,
        bold: html.querySelector("strong")?.textContent,
        italic: html.querySelector("em")?.textContent,
        link: html.querySelector("a")?.href,
        items: [...html.querySelectorAll("li")].map((item) => item.textContent?.trim()),
        code: html.querySelector("pre code")?.textContent?.trim(),
        cells: [...html.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
        editorChrome: html.querySelector("button, [contenteditable], .cm-gutters") !== null,
        plainReadable: text.includes("A bold and italic link.") && text.includes("const answer = 42;"),
      };
    })).toEqual({
      heading: "Copy check", bold: "bold", italic: "italic", link: "https://example.com/",
      items: ["First item", "Second item"], code: "const answer = 42;", cells: ["Sample", "42"],
      editorChrome: false, plainReadable: true,
    });
  });
}

test("Settings and copy remain reachable at the minimum window width", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 720 });
  const toolbar = page.locator(".toolbar");
  const settings = toolbar.getByRole("button", { name: "Settings", exact: true });
  const copyButton = toolbar.getByRole("button", { name: "Copy", exact: true });
  const print = toolbar.getByRole("button", { name: "Print", exact: true });
  await expect(settings).toBeInViewport();
  const bounds = await settings.boundingBox();
  expect(bounds!.x + bounds!.width).toBeGreaterThan(470);
  expect((await copyButton.boundingBox())!.x).toBeLessThan((await print.boundingBox())!.x);
  await toolbar.getByRole("button", { name: "Editor view" }).click();
  await page.getByRole("menuitemradio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw")).toBeVisible();

  await settings.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await toolbar.getByRole("button", { name: "Recent", exact: true }).click();
  await expect(copyButton).toBeDisabled();
  await settings.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("Settings stays at the right edge across toolbar breakpoints", async ({ page }) => {
  for (const width of [480, 621, 660, 661, 769, 770, 859, 860, 975, 976, 1000]) {
    await page.setViewportSize({ width, height: 720 });
    const settings = page.locator(".toolbar").getByRole("button", { name: "Settings", exact: true });
    const bounds = (await settings.boundingBox())!;
    expect(bounds.x + bounds.width, `Settings at ${width}px`).toBeLessThanOrEqual(width);
    expect(bounds.x + bounds.width, `Settings at ${width}px`).toBeGreaterThan(width - 10);
  }
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
