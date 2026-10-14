import { test, expect, type Page } from "@playwright/test";

// M3: frontmatter table (§5.17) and the settings dialog (§5.9). Runs in a plain
// browser; settings persistence (Electron) is a no-op here, but the in-app apply
// path still runs.

const wysiwyg = ".milkdown .ProseMirror";
// The visible WYSIWYG editor body (hidden panes stay alive to preserve undo, §5.19).
const liveWysiwyg = ".editor-pane:not([hidden]) .ProseMirror";
// The "Split" segment of the view control (spec §6.1) opens the raw source in a
// split beside the document, so a frontmatter edit can be verified in the source.
// The source is scoped to its own pane (`.editor-pane-raw`) since the document
// pane's code blocks are `.cm-content` too.
const rawBtn = ".toolbar-view button:has-text('Split')";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
});

// The editable value cell for a given top-level key in the frontmatter table.
const valueFor = (page: Page, key: string) =>
  page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: key, exact: true }) })
    .locator(".frontmatter-value-edit");

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Application menu" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
}

test("frontmatter renders as an editable key/value table by default", async ({ page }) => {
  // §5.17: with showFrontmatterPanel on (the default), the leading `---` block is
  // shown above the editor as a VS Code-style table — one row per top-level key.
  await expect(page.locator(".frontmatter-table")).toBeVisible();
  // The table is labelled with a "Frontmatter" tab so it isn't mistaken for an
  // editable Markdown table (§5.17).
  await expect(page.locator(".frontmatter-table caption .frontmatter-tab")).toHaveText(
    "Frontmatter",
  );
  await expect(page.getByRole("rowheader", { name: "title", exact: true })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "tags", exact: true })).toBeVisible();
  await expect(valueFor(page, "title")).toHaveText("Welcome");
  await expect(valueFor(page, "tags")).toHaveText("[demo, markdown]");
  // A nested mapping renders as a group header + an indented, editable child row.
  await expect(page.getByRole("rowheader", { name: "metadata", exact: true })).toBeVisible();
  await expect(valueFor(page, "category")).toHaveText("demo");

  // The YAML is split off, never rendered as body text in the editor.
  await expect(page.locator(liveWysiwyg)).not.toContainText("title: Welcome");

  // Visual confirmation of the table (gitignored screenshot).
  await page.locator(".editor-pane:not([hidden])").screenshot({
    path: "e2e/__screens__/frontmatter-table.png",
  });

  // In the Markdown view the frontmatter is shown inline. Scope to the visible
  // pane: the hidden WYSIWYG pane's code-block CodeMirror is also a `.cm-content`.
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("title: Welcome");
  await expect(raw).toContainText("tags: [demo, markdown]");
});

test("editing a NESTED value patches its indented YAML line, preserving the rest", async ({
  page,
}) => {
  await valueFor(page, "category").fill("notes");
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("category: notes");
  // Parent mapping + other keys are untouched.
  await expect(raw).toContainText("metadata:");
  await expect(raw).toContainText("title: Welcome");
});

test("adding a field appends a new editable key/value to the YAML", async ({ page }) => {
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  // A new row appears with the placeholder key "key" (focused); set key + value.
  await page.getByRole("rowheader", { name: "key", exact: true }).fill("author");
  await valueFor(page, "author").fill("Example Author");

  await page.locator(rawBtn).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("author: Example Author");
});

// The inserter "+" buttons sit in the gaps, in DOM order: before title, before
// tags, before metadata, before category (a child gap), then the end gap.
test("the between-row + inserts a top-level field exactly in that gap", async ({ page }) => {
  // §5.17: the 2nd inserter is the gap between `title` and `tags`.
  await page.locator(".frontmatter-inserter-btn").nth(1).click();
  // The new placeholder row lands precisely there — not at the bottom.
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["title", "key", "tags", "metadata", "category"]);
});

test("the between-row + in the GROUP-HEADER gap inserts a top-level field BEFORE the mapping (children stay grouped)", async ({
  page,
}) => {
  // The 3rd inserter is the gap before the `metadata` header. Inserting there must
  // land a TOP-LEVEL field before the mapping, NOT orphan `category` under a new key.
  await page.locator(".frontmatter-inserter-btn").nth(2).click();
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["title", "tags", "key", "metadata", "category"]);

  // `category` is still a child of `metadata` (not reparented to the new key).
  await page.getByRole("rowheader", { name: "key", exact: true }).fill("between");
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("between:");
  await expect(raw).toContainText("metadata:");
  await expect(raw).toContainText("category: demo");
});

test("the front gap inserts at the very top, the end gap appends at the bottom", async ({ page }) => {
  // nth(0) is the front gap (above the first row).
  await page.locator(".frontmatter-inserter-btn").nth(0).click();
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["key", "title", "tags", "metadata", "category"]);
  // The last inserter (now nth(-1)) is the end gap; it appends at the bottom.
  await page.locator(".frontmatter-inserter-btn").last().click();
  await expect(keys).toHaveText(["key", "title", "tags", "metadata", "category", "key-2"]);
});

test("an inserter '+' is revealed only by hovering THAT gap, not by hovering a row", async ({
  page,
}) => {
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

test("the between-row + in a mapping's gap inserts a sibling CHILD, not a top-level field", async ({
  page,
}) => {
  // The 4th inserter is the gap before `category` (inside the metadata mapping).
  await page.locator(".frontmatter-inserter-btn").nth(3).click();
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["title", "tags", "metadata", "key", "category"]);

  // It serializes as a child of `metadata` (exact indent asserted in unit tests).
  await page.getByRole("rowheader", { name: "key", exact: true }).fill("priority");
  await valueFor(page, "priority").fill("high");
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("priority: high");
  await expect(raw).toContainText("category: demo");
});

test("a group's gutter + adds a field to that mapping (appended after its last child)", async ({
  page,
}) => {
  await page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "metadata", exact: true }) })
    .getByRole("button", { name: "Add field to this group", exact: true })
    .click();
  // Appended as the mapping's last child (after `category`).
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["title", "tags", "metadata", "category", "key"]);

  await page.getByRole("rowheader", { name: "key", exact: true }).fill("priority");
  await valueFor(page, "priority").fill("high");
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("priority: high");
  await expect(raw).toContainText("category: demo");
});

test("a child row also carries the 'add field to this group' gutter +", async ({ page }) => {
  // The same control appears on each child row and appends to the same mapping.
  await page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "category", exact: true }) })
    .getByRole("button", { name: "Add field to this group", exact: true })
    .click();
  const keys = page.locator(".frontmatter-table tbody th.frontmatter-key");
  await expect(keys).toHaveText(["title", "tags", "metadata", "category", "key"]);
});

test("a plain top-level row has no 'add to group' + — only Delete", async ({ page }) => {
  const titleRow = page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "title", exact: true }) });
  await expect(titleRow.getByRole("button", { name: "Add field to this group" })).toHaveCount(0);
  await expect(titleRow.getByRole("button", { name: "Delete" })).toHaveCount(1);
});

test("deleting a field removes it from the YAML", async ({ page }) => {
  await page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "tags", exact: true }) })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByRole("rowheader", { name: "tags", exact: true })).toHaveCount(0);

  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).not.toContainText("tags: [demo, markdown]");
  await expect(raw).toContainText("title: Welcome");
});

test("renaming a key works; an invalid key (with a colon) is rejected", async ({ page }) => {
  await page.getByRole("rowheader", { name: "title", exact: true }).fill("heading");
  // A colon in a key would corrupt the line — the edit must be rejected.
  await page.getByRole("rowheader", { name: "tags", exact: true }).fill("ta:gs");

  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText("heading: Welcome");
  await expect(raw).toContainText("tags: [demo, markdown]"); // colon edit reverted
  await expect(raw).not.toContainText("ta:gs");
});

test("deleting every field still leaves a working 'Add field' (no dead end)", async ({ page }) => {
  for (const key of ["title", "tags", "metadata"]) {
    await page
      .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: key, exact: true }) })
      .getByRole("button", { name: "Delete" })
      .click();
  }
  await expect(page.locator(".frontmatter-table")).toHaveCount(0);

  const addBtn = page.getByRole("button", { name: "Add field", exact: true });
  await expect(addBtn).toBeVisible();
  await addBtn.click();
  await page.getByRole("rowheader", { name: "key", exact: true }).fill("title");
  await valueFor(page, "title").fill("Back");

  await page.locator(rawBtn).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("title: Back");
});

test("editing a table value patches the YAML while preserving the other fields", async ({
  page,
}) => {
  // A long value to also exercise wrapping: the cell must wrap (not overflow) and
  // the table must stay within / centered in the editor column.
  const long =
    "A deliberately long frontmatter value that should wrap within the table cell instead of widening the table past the editor column";
  await valueFor(page, "title").fill(long);

  // Visual confirmation of shrink-to-content + centering + wrapping (gitignored).
  await page.locator(".editor-pane:not([hidden])").screenshot({
    path: "e2e/__screens__/frontmatter-table-wrap.png",
  });

  // Switch to Markdown view: the flush serializes the table edit back into the doc.
  await page.locator(rawBtn).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await expect(raw).toContainText(`title: ${long}`);
  // The untouched key is preserved exactly.
  await expect(raw).toContainText("tags: [demo, markdown]");
});

test("turning off 'Show frontmatter table' hides it but keeps the YAML", async ({ page }) => {
  await openSettings(page);
  const dialog = page.locator(".dialog");
  const toggle = dialog
    .locator(".dialog-row", { hasText: "Show frontmatter table" })
    .locator("input[type=checkbox]");
  await toggle.uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".dialog")).toHaveCount(0);

  // The table is gone and the YAML isn't dumped into the editor body…
  await expect(page.locator(".frontmatter-table")).toHaveCount(0);
  await expect(page.locator(liveWysiwyg)).not.toContainText("title: Welcome");

  // …but it's still preserved and visible in the Markdown view.
  await page.locator(rawBtn).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText(
    "title: Welcome",
  );
});

test("settings dialog opens, edits a value, saves, and applies it", async ({ page }) => {
  await openSettings(page);
  const dialog = page.locator(".dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".dialog-title")).toHaveText("Settings");

  const widthInput = dialog.locator(".dialog-row", { hasText: "Fixed width" }).locator("input");
  await widthInput.fill("800");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(page.locator(".dialog")).toHaveCount(0);
  const width = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--editor-width").trim(),
  );
  expect(width).toBe("800px");

  // Editor still functioning after the dialog round-trip.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
});

test("changing the bullet style re-mounts WYSIWYG without losing content", async ({ page }) => {
  await openSettings(page);
  const dialog = page.locator(".dialog");
  const bullet = dialog.locator(".dialog-row", { hasText: "Bullet" }).locator("select");
  await bullet.selectOption("*");
  await dialog.getByRole("button", { name: "Save" }).click();

  // The WYSIWYG view re-mounts (serializer changed); content is preserved.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
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
