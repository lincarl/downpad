import { test, expect, type Page } from "@playwright/test";

const livePane = ".editor-pane-wysiwyg:not([hidden])";
const liveSource = ".editor-pane-raw:not([hidden]) .cm-content";
const sampleFrontmatter = [
  "---",
  "title: Welcome",
  "tags: [demo, markdown]",
  "metadata:",
  "  category: demo",
  "---",
];

/** Switch views through the same control used by the other browser suites. */
async function showView(page: Page, name: "Document" | "Split" | "Markdown"): Promise<void> {
  await page.locator(".toolbar-view").getByRole("radio", { name, exact: true }).click();
}

/** Find an editable value in the visible document, excluding retained panes. */
function valueFor(page: Page, key: string) {
  return page
    .locator(`${livePane} .frontmatter-table tr`, {
      has: page.getByRole("rowheader", { name: key, exact: true }),
    })
    .locator(".frontmatter-value-edit");
}

/** Check the sample's exact YAML, including indentation, after flushing the document. */
async function expectUnchangedSample(page: Page): Promise<void> {
  await showView(page, "Markdown");
  const source = page.locator(liveSource);
  await expect(source).toBeVisible();
  await source.press("ControlOrMeta+Home");
  await expect
    .poll(() => source.locator(".cm-line").evaluateAll((lines) => lines.slice(0, 6).map((line) => line.textContent)))
    .toEqual(sampleFrontmatter);
  await expect(page.locator(".tab-dot")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${livePane} .ProseMirror h1`)).toHaveText("Welcome to Downpad");
});

test("frontmatter starts collapsed and keyboard toggles retain their state across views and tabs without editing YAML", async ({ page }) => {
  const toggle = page.locator(`${livePane} .frontmatter-toggle`);
  const content = page.locator(`${livePane} .frontmatter-content`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAccessibleName(/^Frontmatter \d+ fields$/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", /\S+/);
  await expect(content).toHaveAttribute("id", (await toggle.getAttribute("aria-controls"))!);
  await expect(content).toHaveAttribute("hidden", "");
  await expect(content).toBeHidden();
  await expect(page.locator(".tab-dot")).toHaveCount(0);
  await page.locator(livePane).screenshot({ path: "e2e/__screens__/frontmatter-collapsed.png" });

  // Enter opens the button and Space closes it. Both states must survive the
  // normal pane cache, including a visit to a tab without frontmatter.
  for (const expanded of [true, false]) {
    await toggle.focus();
    await page.keyboard.press(expanded ? "Enter" : "Space");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    if (expanded) {
      await expect(content).toBeVisible();
      await expect(content).not.toHaveAttribute("hidden");
      await expect(content).toHaveCSS("max-height", "none");
      await expect(content).toHaveCSS("overflow-y", "visible");
      await expect(valueFor(page, "title")).toHaveText("Welcome");
    } else {
      await expect(content).toHaveAttribute("hidden", "");
      await expect(content).toBeHidden();
    }

    await expectUnchangedSample(page);
    await showView(page, "Split");
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    await showView(page, "Document");
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));

    await page.locator(".tab-new").click();
    await expect(page.locator(".tab")).toHaveCount(expanded ? 2 : 3);
    await expect(page.locator(`${livePane} .ProseMirror`)).toBeVisible();
    await expect(toggle).toHaveCount(0);
    await page.locator(".tab").first().click();
    await expect(page.locator(`${livePane} h1`)).toHaveText("Welcome to Downpad");
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    await expect(page.locator(".tab-dot")).toHaveCount(0);
  }
  await expectUnchangedSample(page);
});

test("Find reveals a collapsed frontmatter match and keeps the find field focused", async ({ page }) => {
  const toggle = page.locator(`${livePane} .frontmatter-toggle`);
  const findInput = page.getByRole("textbox", { name: "Find in document" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator(`${livePane} h1`).click();
  await page.keyboard.press("ControlOrMeta+f");

  // A body-only result leaves the disclosure closed. The sample has one
  // "category" match, in the frontmatter's nested key.
  await findInput.fill("lightweight");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await findInput.fill("category");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const key = page.locator(livePane).getByRole("rowheader", { name: "category", exact: true });
  await expect(key).toBeInViewport();
  await expect(findInput).toBeFocused();

  // A subsequent Next also reveals the current result after a manual collapse.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await findInput.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(key).toBeInViewport();
  await expect(findInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".find-bar")).toBeHidden();
  await expect(key).toBeFocused();
  await expectUnchangedSample(page);
});

test("undo and redo reveal a collapsed edited cell without undoing the disclosure", async ({ page }) => {
  const toggle = page.locator(`${livePane} .frontmatter-toggle`);
  await toggle.click();
  await valueFor(page, "title").fill("Changed title");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // One undo from the body reaches the table edit, with no disclosure step
  // ahead of it. Returning the caret to that cell must make it visible.
  await page.locator(`${livePane} h1`).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(valueFor(page, "title")).toHaveText("Welcome");
  await expect(valueFor(page, "title")).toBeFocused();
  await expect(page.locator(".tab-dot")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator(`${livePane} h1`).click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(valueFor(page, "title")).toHaveText("Changed title");
  await expect(valueFor(page, "title")).toBeFocused();
  await expect(page.locator(".tab-dot")).toHaveCount(1);
});

for (const block of [
  { name: "empty", yaml: "", text: null },
  { name: "comments-only", yaml: "# Keep this comment\n", text: "# Keep this comment" },
  { name: "unsupported", yaml: "- first\n- second\n", text: "- first\n- second" },
]) {
  test(`a recognized ${block.name} block still has a collapsed disclosure`, async ({ page }) => {
    await showView(page, "Markdown");
    const source = page.locator(liveSource);
    await source.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(`---\n${block.yaml}---\n\n# Body\n`);
    await showView(page, "Document");
    await expect(page.locator(`${livePane} h1`)).toHaveText("Body");
    const toggle = page.locator(`${livePane} .frontmatter-toggle`);
    const content = page.locator(`${livePane} .frontmatter-content`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(content).toBeHidden();
    await toggle.click();
    await expect(content).toBeVisible();
    if (block.text === null) {
      await expect(content.getByRole("button", { name: "Add field", exact: true })).toBeVisible();
    } else {
      await expect(content.locator(".frontmatter-code")).toHaveText(block.text);
    }
  });
}
