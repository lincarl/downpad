import { expect, test, type Page } from "@playwright/test";

/** Enter source through the Markdown pane, then show its document rendering. */
async function setSource(page: Page, markdown: string): Promise<void> {
  await page.locator(".toolbar-view").getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(markdown);
  await page.locator(".toolbar-view").getByRole("radio", { name: "Document", exact: true }).click();
}

test("Pele diagrams follow the document theme and print in light colors", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".ProseMirror h1")).toContainText("Welcome to Downpad");
  await setSource(page, '```mermaid\nflowchart LR\naccTitle: Publishing\nDraft --> Review --> Published\n```\n');
  const drawing = page.locator(".editor-pane-wysiwyg svg.pele");
  await expect(drawing).toBeVisible();
  await expect(drawing).toHaveAccessibleName("Publishing");
  const label = drawing.locator(".pele-label").first();
  await expect(label).toHaveCSS("fill", "rgb(26, 26, 26)");
  const markup = await drawing.evaluate((element) => element.outerHTML);
  await page.getByRole("button", { name: "Switch to dark document theme", exact: true }).click();
  await expect(label).toHaveCSS("fill", "rgb(212, 212, 212)");
  expect(await drawing.evaluate((element) => element.outerHTML)).toBe(markup);
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const printed = page.locator(".print-page svg.pele");
  await expect(printed).toBeVisible();
  await expect(printed.locator(".pele-label").first()).toHaveCSS("fill", "rgb(0, 0, 0)");
});

test("a diagram recovers after invalid source is corrected", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".ProseMirror h1")).toContainText("Welcome to Downpad");
  await setSource(page, '```mermaid\ngraph LR\nA["unfinished\n```\n');
  await expect(page.locator(".mermaid-error")).toBeVisible();
  await setSource(page, '```mermaid\nsequenceDiagram\nAlice->>Bob: Hello\n```\n');
  await expect(page.locator(".mermaid-error")).toHaveCount(0);
  await expect(page.locator("svg.pele-sequence")).toBeVisible();
});

test("an edit turns the document icon red and undo restores its saved color", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator(".ProseMirror h1").first();
  await expect(heading).toContainText("Welcome to Downpad");
  const icon = page.getByRole("tab", { name: "Untitled", exact: true }).locator(".tab-file-icon");
  const savedColor = await icon.evaluate((element) => getComputedStyle(element).color);
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edit");
  await expect(icon).toHaveClass(/is-dirty/);
  const danger = await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--ink-danger").trim());
  const color = await icon.evaluate((element, danger) => {
    const sample = document.createElement("span");
    sample.style.color = danger;
    element.parentElement!.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  }, danger);
  await expect(icon).toHaveCSS("color", color);
  await expect(page.locator(".tab-dot")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(icon).not.toHaveClass(/is-dirty/);
  await expect(icon).toHaveCSS("color", savedColor);
});
