import { test, expect } from "@playwright/test";

// The print workspace (spec §5.21 / print/PrintWorkspace): Ctrl+P, the toolbar
// Print button and the right-click menu all open md-easy's own full-window print
// mode instead of printing straight away. The preview shows the very `.print-page`
// elements that get printed, so these tests assert on the real sheets.
//
// Regression guard for the "blank leading sheet" bug: the mount container `#app`
// is `height: 100vh`, so hiding only the inner `.app` left the empty container
// occupying a full first page and pushed the document onto page 2. The print
// stylesheet must hide `#app` itself so `.print-root` starts at top 0.

const wysiwyg = ".milkdown .ProseMirror";

async function openWorkspace(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();
}

test("the Print button opens the workspace with a paginated preview", async ({ page }) => {
  await openWorkspace(page);

  // Sheets are real A4 boxes (210 × 297 mm at 96 dpi), not a scrolling column.
  const size = await page.evaluate(() => {
    const sheet = document.querySelector(".print-page") as HTMLElement;
    return { width: sheet.offsetWidth, height: sheet.offsetHeight };
  });
  expect(size.width).toBeGreaterThan(780);
  expect(size.width).toBeLessThan(800);
  expect(size.height).toBeGreaterThan(1110);
  expect(size.height).toBeLessThan(1135);

  // The running header is off by default (§5.21) — nothing is stamped on the page
  // unless the user asks for it.
  await expect(page.locator(".print-page .print-page-header")).toHaveCount(0);
  // Ticking a header field puts the band on every sheet — ours, not a browser's.
  await page.getByLabel("Document title in header").check();
  await expect(page.locator(".print-page .print-page-header")).toHaveCount(
    await page.locator(".print-page").count(),
  );
  // Page numbers stay on by default.
  await expect(page.locator(".print-page .print-page-footer").first()).toHaveText("1 / 1");
  await expect(page.locator(".print-ws-summary")).toContainText("A4 portrait");
});

test("the version chooser switches between the document and the Markdown source", async ({
  page,
}) => {
  await openWorkspace(page);
  // Document version: the rendered heading.
  await expect(page.locator(".print-page .print-doc.milkdown h1")).toContainText(
    "Welcome to md-easy",
  );
  await expect(page.locator(".print-source")).toHaveCount(0);

  await page.click('.print-ws-segmented button:has-text("Markdown")');
  // Markdown version: the raw source, one block per line, nothing rendered. The
  // source is the canonical markdown, so the YAML frontmatter prints too — it is
  // part of the file, and only the Document version hides it (§5.17).
  await expect(page.locator(".print-page .print-source").first()).toBeVisible();
  await expect(page.locator(".print-src-line").first()).toHaveText("---");
  await expect(page.locator(".print-src-line", { hasText: "# Welcome to md-easy" })).toHaveCount(1);
  await expect(page.locator(".print-page h1")).toHaveCount(0);
});

test("changing the page setup re-paginates the preview", async ({ page }) => {
  await openWorkspace(page);
  const portraitWidth = await page.evaluate(
    () => (document.querySelector(".print-page") as HTMLElement).offsetWidth,
  );

  await page.selectOption('.print-ws-rail select[aria-label="Orientation"]', "landscape");
  const landscapeWidth = await page.evaluate(
    () => (document.querySelector(".print-page") as HTMLElement).offsetWidth,
  );
  expect(landscapeWidth).toBeGreaterThan(portraitWidth);
  await expect(page.locator(".print-ws-summary")).toContainText("A4 landscape");
});

test("enabling page numbers reserves the footer band without clipping content", async ({ page }) => {
  await openWorkspace(page);
  await page.getByLabel("Page numbers in footer").uncheck();
  await page.getByLabel("Page numbers in footer").check();

  const overflow = await page.locator(".print-page-body").evaluateAll((bodies) =>
    bodies.map((body) => ({ client: body.clientHeight, scroll: body.scrollHeight })),
  );
  for (const body of overflow) expect(body.scroll).toBeLessThanOrEqual(body.client + 1);
});

test("printing hides the full-height #app so there is no blank leading page", async ({ page }) => {
  await openWorkspace(page);

  // Stub window.print so it never opens a dialog and `afterprint` never fires —
  // the print DOM (`.print-root` + the `printing` class) then stays mounted for
  // us to inspect instead of being torn down immediately.
  await page.evaluate(() => {
    window.print = () => {};
  });

  await page.click('.print-ws-top button:has-text("Print")');
  await page.waitForFunction(() => document.documentElement.classList.contains("printing"));
  await page.emulateMedia({ media: "print" });

  const geom = await page.evaluate(() => {
    const appEl = document.querySelector("#app") as HTMLElement;
    const root = document.querySelector(".print-root") as HTMLElement;
    return {
      appDisplay: getComputedStyle(appEl).display,
      workspaceDisplay: getComputedStyle(document.querySelector(".print-workspace")!).display,
      // The sheets must sit directly under <body>: `@media print` hides `#app`.
      rootIsBodyChild: root.parentElement === document.body,
      rootTop: Math.round(root.getBoundingClientRect().top),
      pages: root.querySelectorAll(".print-page").length,
    };
  });

  // The mount container and the workspace chrome are removed from the print flow.
  expect(geom.appDisplay).toBe("none");
  expect(geom.workspaceDisplay).toBe("none");
  expect(geom.rootIsBodyChild).toBe(true);
  // …so the printed document begins at the very top of the page — no blank sheet.
  expect(geom.rootTop).toBe(0);
  expect(geom.pages).toBeGreaterThan(0);

  await page.emulateMedia({ media: "screen" });
});

test("a table taller than a page splits, repeating its header and losing no rows", async ({
  page,
}) => {
  // Regression: `splitBlock` dispatched on the flow child's own tag name, but Crepe
  // wraps a table in `div.milkdown-table-block > div > div.table-wrapper`, so
  // nothing matched and the over-tall table was clipped by the page box — its last
  // rows vanished from the printout. Crepe also keeps every row in one `<tbody>`
  // and marks the header `data-is-header`, so `table.tHead` is null: reading only
  // `tHead` left every page after the first without column names.
  const rows = Array.from({ length: 30 }, (_, i) => `| row${i} | value ${i} |`);
  const markdown = ["# Long table", "", "| Feature | Behaviour |", "| --- | --- |", ...rows].join(
    "\n",
  );

  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await page.click(".toolbar-view button:has-text('Split')");
  const raw = page.locator(".editor-pane-raw .cm-content");
  await raw.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(markdown);
  await expect(page.locator(`${wysiwyg} table tr`)).toHaveCount(31);

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();

  const result = await page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".print-page"));
    const labels: string[] = [];
    let headerlessPieces = 0;
    let clippedPieces = 0;
    for (const sheet of sheets) {
      const block = sheet.querySelector<HTMLElement>(".milkdown-table-block");
      if (!block) continue;
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      if (block.offsetHeight > body.offsetHeight) clippedPieces++;
      const rowEls = Array.from(block.querySelectorAll<HTMLTableRowElement>("tr"));
      const header = rowEls.filter((r) => r.dataset.isHeader === "true");
      if (header.length !== 1) headerlessPieces++;
      for (const row of rowEls.slice(header.length)) {
        labels.push(row.children[0].textContent ?? "");
      }
    }
    return {
      pieces: sheets.filter((s) => s.querySelector(".milkdown-table-block")).length,
      labels,
      headerlessPieces,
      clippedPieces,
    };
  });

  // The table really did span more than one sheet.
  expect(result.pieces).toBeGreaterThan(1);
  // Every piece carries the header row, and none overflows its page box.
  expect(result.headerlessPieces).toBe(0);
  expect(result.clippedPieces).toBe(0);
  // Every row printed exactly once, in order: nothing clipped, nothing duplicated.
  expect(result.labels).toEqual(Array.from({ length: 30 }, (_, i) => `row${i}`));
});

test("an over-tall code block and list split too, keeping line numbers and item order", async ({
  page,
}) => {
  // Same wrapper trap as the table, in two more places. Crepe renders code through
  // CodeMirror rather than a `<pre>`, and each list item as
  // `<ul><div class="milkdown-list-item-block"><li>…`, so neither splitter matched
  // and both blocks were clipped at the page edge.
  const code = Array.from({ length: 60 }, (_, i) => `export const step${i + 1} = ${i + 1};`);
  const items = Array.from({ length: 40 }, (_, i) => `- item ${i + 1}`);
  const markdown = ["# Long blocks", "", "```ts", ...code, "```", "", ...items].join("\n");

  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await page.click(".toolbar-view button:has-text('Split')");
  const raw = page.locator(".editor-pane-raw .cm-content");
  await raw.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(markdown);
  await expect(page.locator(`${wysiwyg} .milkdown-list-item-block`)).toHaveCount(40);

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();

  const result = await page.evaluate(() => {
    const numbers: string[] = [];
    const listItems: string[] = [];
    let codePieces = 0;
    let listPieces = 0;
    let clipped = 0;
    for (const sheet of Array.from(document.querySelectorAll<HTMLElement>(".print-page"))) {
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      for (const block of Array.from(sheet.querySelectorAll<HTMLElement>(".print-flow > *"))) {
        if (block.offsetHeight > body.offsetHeight) clipped++;
      }
      const codeBlock = sheet.querySelector<HTMLElement>(".milkdown-code-block");
      if (codeBlock) {
        codePieces++;
        for (const cell of Array.from(codeBlock.querySelectorAll(".cm-gutterElement"))) {
          // Skip CodeMirror's hidden width-measuring spacer.
          if (getComputedStyle(cell).visibility === "hidden") continue;
          numbers.push(cell.textContent ?? "");
        }
      }
      const list = sheet.querySelector<HTMLElement>("ul");
      if (list) {
        listPieces++;
        for (const li of Array.from(list.querySelectorAll("li"))) {
          listItems.push((li.textContent ?? "").trim());
        }
      }
    }
    return { codePieces, listPieces, clipped, numbers, listItems };
  });

  // Both blocks really did span more than one sheet, and nothing overflows a page.
  expect(result.codePieces).toBeGreaterThan(1);
  expect(result.listPieces).toBeGreaterThan(1);
  expect(result.clipped).toBe(0);
  // Line numbers run 1..60 unbroken across the pieces, matched to their own lines.
  expect(result.numbers).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)));
  // Every list item printed exactly once, in order.
  expect(result.listItems).toEqual(Array.from({ length: 40 }, (_, i) => `item ${i + 1}`));
});
