import { test, expect } from "@playwright/test";

// Verifies the three-segment view control (§6.1): Document | Split | Markdown.
// "Document" shows only the document (WYSIWYG) view; "Split" opens the raw Markdown
// source in a split beside it (both panes live over one canonical string, edits in
// either mirrored into the other); "Markdown" shows only the raw source.

const wysiwyg = ".milkdown .ProseMirror";
// In the split, BOTH panes are visible, and the document pane's embedded code
// blocks are also `.cm-content` — so scope the raw source to its own pane.
const rawContent = ".editor-pane-raw .cm-content";
const documentSeg = ".toolbar-view button:has-text('Document')";
const splitSeg = ".toolbar-view button:has-text('Split')";
const markdownSeg = ".toolbar-view button:has-text('Markdown')";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // WYSIWYG mounts asynchronously; wait for the seeded heading to render.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
});

test("the control starts on Document, with that segment active", async ({ page }) => {
  // Default layout: only the document is shown, "Document" is the active segment.
  await expect(page.locator(rawContent)).toHaveCount(0);
  await expect(page.locator(documentSeg)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(splitSeg)).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(markdownSeg)).toHaveAttribute("aria-checked", "false");
});

test("'Split' shows the Markdown source beside the document", async ({ page }) => {
  await page.locator(splitSeg).click();

  // The document stays visible; the raw source appears alongside it.
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  const raw = page.locator(rawContent);
  await expect(raw).toBeVisible();
  // The raw view shows literal markdown: heading syntax, a fenced code block,
  // and the GFM table all survived WYSIWYG serialization.
  await expect(raw).toContainText("# Welcome to md-easy");
  await expect(raw).toContainText("```ts");
  await expect(raw).toContainText("| Feature | Status |");
  // "Split" is now the active segment.
  await expect(page.locator(splitSeg)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(documentSeg)).toHaveAttribute("aria-checked", "false");
});

test("an edit in the document keeps a standalone image's alt text", async ({ page }) => {
  // Crepe stores its resize ratio in an image block's alt text, so an edit in the
  // document used to write this image back as ![1.00](…).
  const square =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNkYGD4z0AEYBxVSF+FAP5FBQXxiME7AAAAAElFTkSuQmCC";
  await page.locator(markdownSeg).click();
  await page.locator(rawContent).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(`![A tiny square](${square})\n\nText\n`);
  await page.locator(documentSeg).click();
  await page.locator(`${wysiwyg} p`).last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" here");
  await page.locator(markdownSeg).click();
  // The source view shows the base64 data collapsed, so match up to it.
  await expect(page.locator(rawContent)).toContainText("![A tiny square](data:image/png;base64,");
});

test("a standalone image is announced by its alt text, or its caption without one", async ({ page }) => {
  // Crepe's image view used the caption as the alt, so the alt text went unread.
  const square =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNkYGD4z0AEYBxVSF+FAP5FBQXxiME7AAAAAElFTkSuQmCC";
  await page.locator(markdownSeg).click();
  await page.locator(rawContent).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(`![A tiny square](${square} "Square caption")\n\n![](${square} "Only a caption")\n`);
  await page.locator(documentSeg).click();
  const document = page.locator(wysiwyg);
  await expect(document.getByRole("img", { name: "A tiny square", exact: true })).toBeVisible();
  await expect(document.getByRole("img", { name: "Only a caption", exact: true })).toBeVisible();
  await expect(document.getByRole("img", { name: "Square caption", exact: true })).toHaveCount(0);
});

test("'Markdown' shows only the raw source (the document is hidden)", async ({ page }) => {
  await page.locator(markdownSeg).click();

  const raw = page.locator(rawContent);
  await expect(raw).toBeVisible();
  await expect(raw).toContainText("# Welcome to md-easy");
  // The document (WYSIWYG) pane is hidden in the Markdown-only view.
  await expect(page.locator(`${wysiwyg} h1`)).toBeHidden();
  await expect(page.locator(markdownSeg)).toHaveAttribute("aria-checked", "true");
});

test("'Document' returns to the document-only view from the split", async ({ page }) => {
  await page.locator(splitSeg).click(); // open the split
  await expect(page.locator(rawContent)).toBeVisible();

  await page.locator(documentSeg).click(); // back to document only
  await expect(page.locator(rawContent)).toBeHidden();
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await expect(page.locator(documentSeg)).toHaveAttribute("aria-checked", "true");
});

test("switching Document → Markdown → Document keeps the document intact", async ({ page }) => {
  await page.locator(markdownSeg).click();
  await expect(page.locator(rawContent)).toContainText("# Welcome to md-easy");

  await page.locator(documentSeg).click();
  await expect(page.locator(rawContent)).toBeHidden();
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
});

test("the find card opens with Ctrl+F, follows the Markdown view and closes on Escape", async ({
  page,
}) => {
  // Find is a floating card, closed until it is asked for.
  const findBar = page.locator(".find-bar");
  const findInput = page.getByRole("textbox", { name: "Find in document" });
  await expect(findBar).toBeHidden();

  await page.locator(`${wysiwyg} h1`).click();
  await page.keyboard.press("Control+f");
  await expect(findBar).toBeVisible();
  await expect(findInput).toBeFocused();
  await expect(page.getByRole("button", { name: "Find", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Markdown-only routes the same card into CodeMirror; no second CodeMirror
  // panel opens and Ctrl+F returns focus to the card's field.
  await page.locator(markdownSeg).click();
  await page.locator(rawContent).click();
  await page.keyboard.press("Control+f");
  await expect(findInput).toBeFocused();
  await expect(page.locator(".cm-search")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(findBar).toBeHidden();
});

test("an edit in the Markdown pane is mirrored live into the document (split)", async ({ page }) => {
  await page.locator(splitSeg).click();
  const raw = page.locator(rawContent);
  await raw.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\nzzfromraw\n");

  // The document re-parses the canonical and shows the new paragraph (debounced).
  await expect(page.locator(wysiwyg)).toContainText("zzfromraw");
});

test("an edit in the document is mirrored live into the Markdown pane (split)", async ({ page }) => {
  await page.locator(splitSeg).click();
  const doc = page.locator(wysiwyg);
  await doc.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" zzfromdoc");

  await expect(page.locator(rawContent)).toContainText("zzfromdoc");
});

test("editing in the Markdown pane keeps the exact source (the document mirror never reformats it)", async ({
  page,
}) => {
  // Regression: Crepe's markdownUpdated is debounced (~200ms). After the document
  // mirror re-parses the raw text, its delayed re-serialization (normalized: a "-"
  // bullet) must NOT be written back over the source's exact "*" bullet.
  await page.locator(splitSeg).click();
  const raw = page.locator(rawContent);
  await raw.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("* star bullet item\n\nzzmarker\n");

  // The document parses it (debounced); confirm the round-trip ran.
  await expect(page.locator(wysiwyg)).toContainText("zzmarker");
  // Wait well past the 200ms markdownUpdated debounce + 120ms mirror sync so any
  // echo would have fired by now.
  await page.waitForTimeout(600);

  // The raw source still holds the exact "*" bullet — not the serializer's "-".
  await expect(raw).toContainText("* star bullet item");
  await expect(raw).not.toContainText("- star bullet item");
});

test("opening then closing the split preserves the document's undo history", async ({ page }) => {
  // Type a unique marker into the document.
  const doc = page.locator(wysiwyg);
  await doc.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" zzundomarker");
  await expect(doc).toContainText("zzundomarker");

  // Open the split and close it again — the document editor instance is kept
  // alive throughout, so its undo history must still be intact.
  await page.locator(splitSeg).click();
  await expect(page.locator(rawContent)).toBeVisible();
  await page.locator(documentSeg).click();
  await expect(page.locator(rawContent)).toBeHidden();

  await doc.click();
  await page.keyboard.press("Control+z");
  await expect(doc).not.toContainText("zzundomarker"); // undo worked
});
