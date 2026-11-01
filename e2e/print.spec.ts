import { test, expect } from "@playwright/test";

// The print workspace (spec §5.21 / print/PrintWorkspace): Ctrl+P, the toolbar
// Print button and the right-click menu all open Downpad's own full-window print
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
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();
}

/** Replace the welcome document with `markdown`, typed into the split view's Markdown pane. */
async function typeDocument(page: import("@playwright/test").Page, markdown: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
  await page.click(".toolbar-view button:has-text('Split')");
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(markdown);
}

/**
 * How far anything on the printed sheets reaches past its page body, in page
 * px: a block, a block shrunk to fit inside its frame, or a line of text. Also
 * the sheets' visible text, without whitespace, leaving out what `leaveOut`
 * matches.
 */
function printedSheets(
  page: import("@playwright/test").Page,
  leaveOut = "",
): Promise<{ overflow: number; texts: string[] }> {
  return page.evaluate((leaveOut) => {
    let overflow = -Infinity;
    const texts: string[] = [];
    const range = document.createRange();
    for (const sheet of Array.from(document.querySelectorAll<HTMLElement>(".print-workspace .print-page"))) {
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      const box = body.getBoundingClientRect();
      const scale = box.height / body.offsetHeight;
      const past = (rect: DOMRect): number => (rect.bottom - box.top) / scale - body.clientHeight;
      const flow = sheet.querySelector<HTMLElement>(".print-flow")!;
      for (const block of Array.from(flow.querySelectorAll(":scope > *, .print-fit > *"))) {
        overflow = Math.max(overflow, past(block.getBoundingClientRect()));
      }
      const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        // KaTeX keeps a copy of each formula for screen readers, clipped away.
        if (getComputedStyle(text.parentElement!).visibility === "hidden" || text.parentElement!.closest(".katex-mathml")) continue;
        range.selectNodeContents(text);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width || rect.height) overflow = Math.max(overflow, past(rect));
        }
      }
      const visible = flow.cloneNode(true) as HTMLElement;
      visible.querySelectorAll(['[style*="visibility: hidden"]', leaveOut].filter(Boolean).join(", ")).forEach((hidden) => hidden.remove());
      texts.push(visible.textContent!.replace(/\s+/g, ""));
    }
    return { overflow, texts };
  }, leaveOut);
}

/**
 * The document view's text, without whitespace, as the Document version
 * prints it, leaving out what `leaveOut` matches. The URL shown after a link
 * is generated content on screen and text in print (printRender.ts).
 */
function printableText(page: import("@playwright/test").Page, leaveOut = ""): Promise<string> {
  return page.locator(wysiwyg).evaluate((node, leaveOut) => {
    const copy = node.cloneNode(true) as HTMLElement;
    if (leaveOut) copy.querySelectorAll(leaveOut).forEach((left) => left.remove());
    copy.querySelectorAll<HTMLElement>(".md-link-url").forEach((url) => {
      url.textContent = ` (${url.dataset.url})`;
    });
    return copy.textContent!.replace(/\s+/g, "");
  }, leaveOut);
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

  // The running header is off by default (§5.21). Nothing is stamped on the page
  // unless the user asks for it.
  await expect(page.locator(".print-page .print-page-header")).toHaveCount(0);
  // Ticking a header field puts our band, not a browser's, on every sheet.
  await page.getByLabel("Document title in header").check();
  await expect(page.locator(".print-page .print-page-header")).toHaveCount(
    await page.locator(".print-page").count(),
  );
  // Page numbers stay on by default.
  await expect(page.locator(".print-page .print-page-footer").first()).toHaveText("1 / 1");
  await expect(page.locator(".print-ws-paper")).toContainText("A4 · Portrait");
});

test("the version chooser switches between the document and the Markdown source", async ({
  page,
}) => {
  await openWorkspace(page);
  // Document version: the rendered heading.
  await expect(page.locator(".print-page .print-doc.milkdown h1")).toContainText(
    "Welcome to Downpad",
  );
  await expect(page.locator(".print-source")).toHaveCount(0);

  await page.locator(".print-workspace").getByRole("radio", { name: "Markdown", exact: true }).check();
  // Markdown version: the raw source, one block per line, nothing rendered. The
  // source is the canonical markdown, so the YAML frontmatter prints too. It is
  // part of the file, and only the Document version hides it (§5.17).
  await expect(page.locator(".print-page .print-source").first()).toBeVisible();
  await expect(page.locator(".print-src-line").first()).toHaveText("---");
  await expect(page.locator(".print-src-line", { hasText: "# Welcome to Downpad" })).toHaveCount(1);
  await expect(page.locator(".print-page h1")).toHaveCount(0);
});

test("printing hides the full-height #app so there is no blank leading page", async ({ page }) => {
  await openWorkspace(page);

  // Stub window.print so it never opens a dialog and `afterprint` never fires.
  // The print DOM (`.print-root` and the `printing` class) then stays mounted for
  // us to inspect instead of being torn down immediately.
  await page.evaluate(() => {
    window.print = () => {};
  });

  await page.locator(".print-ws-footer").getByRole("button", { name: "Print", exact: true }).click();
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
  // So the printed document begins at the very top of the page, with no blank sheet.
  expect(geom.rootTop).toBe(0);
  expect(geom.pages).toBeGreaterThan(0);

  await page.emulateMedia({ media: "screen" });
});

test("an over-tall code block and list split too, keeping line numbers and item order", async ({
  page,
}) => {
  // Crepe wraps blocks the splitter dispatched on by tag name. It renders code
  // through CodeMirror rather than a `<pre>`, and each list item as
  // `<ul><div class="milkdown-list-item-block"><li>…`, so neither splitter matched
  // and both blocks were clipped at the page edge.
  const code = Array.from({ length: 60 }, (_, i) => `export const step${i + 1} = ${i + 1};`);
  const items = Array.from({ length: 40 }, (_, i) => `- item ${i + 1}`);
  const markdown = ["# Long blocks", "", "```ts", ...code, "```", "", ...items].join("\n");

  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");
  await page.click(".toolbar-view button:has-text('Split')");
  const raw = page.locator(".editor-pane-raw .cm-content");
  await raw.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(markdown);
  await expect(page.locator(`${wysiwyg} .milkdown-list-item-block`)).toHaveCount(40);

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();

  const result = await page.evaluate(() => {
    const numbers: string[] = [];
    const sourceLines: string[] = [];
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
        for (const line of codeBlock.querySelectorAll(".cm-line")) {
          sourceLines.push(line.textContent ?? "");
        }
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
    return { codePieces, listPieces, clipped, numbers, sourceLines, listItems };
  });

  // Both blocks really did span more than one sheet, and nothing overflows a page.
  expect(result.codePieces).toBeGreaterThan(1);
  expect(result.listPieces).toBeGreaterThan(1);
  expect(result.clipped).toBe(0);
  // Line numbers run 1..60 unbroken across the pieces, matched to their own lines.
  expect(result.numbers).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)));
  expect(result.sourceLines).toEqual(code);
  // Every list item printed exactly once, in order.
  expect(result.listItems).toEqual(Array.from({ length: 40 }, (_, i) => `item ${i + 1}`));
});

test("a paragraph, quote and list item taller than a page continue on the next sheets", async ({
  page,
}) => {
  // The Document version broke pages only between blocks, so a paragraph, a
  // quote or a list item taller than a page got a sheet to itself and the page
  // body cut it off. Real layout decides where lines wrap, so only a browser can
  // show that every break falls between lines and every sheet fits.
  const words = (label: string, count: number): string =>
    Array.from({ length: count }, (_, i) => `${label}${i + 1}`).join(" ");
  const paragraph =
    `${words("w", 300)} **${words("bold", 600)}** *${words("em", 50)}* ` +
    `[${words("link", 30)}](https://example.com/long) \`code\` $x^2$ ${words("v", 800)} END_PARA`;
  const markdown = [
    "# Long blocks",
    "",
    "Intro.",
    "",
    paragraph,
    "",
    "> Quote start.",
    ">",
    ...Array.from({ length: 60 }, (_, i) => `> > nested ${i + 1}\n> >`),
    "> " + words("q", 900) + " END_QUOTE",
    "",
    "- Short item",
    "- " + words("item", 1200) + " END_ITEM",
    "- Last item",
    "",
    "The end.",
  ].join("\n");

  await typeDocument(page, markdown);
  await expect(page.locator(`${wysiwyg} blockquote blockquote p`)).toHaveCount(60);
  await expect(page.locator(`${wysiwyg} li`).last()).toContainText("Last item");
  const documentText = await printableText(page);
  const boldText = await page.locator(`${wysiwyg} strong`).textContent();

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-page").first()).toBeVisible();

  const result = await page.evaluate(() => {
    let overflow = 0;
    const texts: string[] = [];
    const bold: string[] = [];
    let boldSheets = 0;
    let shownLabels = 0;
    let hiddenLabels = 0;
    for (const sheet of Array.from(document.querySelectorAll<HTMLElement>(".print-page"))) {
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      const box = body.getBoundingClientRect();
      const scale = box.height / body.offsetHeight;
      const flow = sheet.querySelector<HTMLElement>(".print-flow")!;
      for (const block of Array.from(flow.children)) {
        overflow = Math.max(overflow, (block.getBoundingClientRect().bottom - box.top) / scale - body.clientHeight);
      }
      const visible = flow.cloneNode(true) as HTMLElement;
      visible.querySelectorAll('[style*="visibility: hidden"]').forEach((hidden) => hidden.remove());
      texts.push(visible.textContent!.replace(/\s+/g, ""));
      const strong = Array.from(flow.querySelectorAll("strong"), (part) => part.textContent!);
      bold.push(...strong);
      if (strong.length) boldSheets++;
      for (const label of Array.from(flow.querySelectorAll<HTMLElement>(".label-wrapper"))) {
        if (label.style.visibility === "hidden") hiddenLabels++;
        else shownLabels++;
      }
    }
    return { overflow, text: texts.join(""), bold: bold.join(""), boldSheets, shownLabels, hiddenLabels };
  });

  // No block reaches past its page body, so the page clips nothing.
  expect(result.overflow).toBeLessThanOrEqual(0.5);
  // Every character prints once, in order.
  expect(result.text).toBe(documentText);
  // The bold text continues as bold on the next sheet.
  expect(result.boldSheets).toBeGreaterThan(1);
  expect(result.bold).toBe(boldText);
  // The long item continues beside its bullet's place, showing the bullet once.
  expect(result.shownLabels).toBe(3);
  expect(result.hiddenLabels).toBeGreaterThan(0);
});

test("quotes and list items that begin with a heading, and quotes around a table or code, fit their sheets from 50% to 200% on A4 and A5", async ({ page }) => {
  // A heading's top margin collapses with the margin of a quote that begins
  // with it, into one margin above the quote, and a table or code block in a
  // quote shares its margin with the quote's the same way. The paginator left
  // room for the quote's own 4 px above a quote that started a sheet rather
  // than the heading's 28 px, so the page body cut off the end of a sheet that
  // the quote filled, 33 px past the body at 200% on A4. This prints such
  // quotes, quotes around a table and a code block, and lists whose items
  // begin with headings, with a running header and page numbers, at four
  // scales on three kinds of sheet.
  test.setTimeout(240_000);
  const words = (label: string, count: number): string =>
    Array.from({ length: count }, (_, i) => `${label}${i}`).join(" ");
  // Notes and paragraphs of many lengths, so some note starts a sheet and
  // fills it at every setup.
  const notes = Array.from({ length: 48 }, (_, k) => [
    `> ## Note ${k}`,
    ">",
    `> ${words(`n${k}x`, 15 + ((13 * k) % 80))}`,
    "",
    ...Array.from({ length: k % 3 }, (_, j) => [words(`p${k}y${j}z`, 15 + ((29 * k + 41 * j) % 80)), ""]).flat(),
  ]).flat();
  const items = Array.from({ length: 24 }, (_, k) => [
    `- ## Item ${k}`,
    "",
    `  ${words(`i${k}x`, 10 + ((17 * k) % 90))}`,
    "",
  ]).flat();
  const code = Array.from({ length: 150 }, (_, i) => `export const step${i + 1} = ${i + 1};`);
  const markdown = [
    "# Notes",
    "",
    ...notes,
    `> ## Long note`,
    ">",
    `> ${words("long", 1500)}`,
    "",
    "> | A | B |",
    "> | --- | --- |",
    ...Array.from({ length: 70 }, (_, i) => `> | qa${i} | qb ${i} |`),
    "",
    "> ```ts",
    ...code.map((line) => `> ${line}`),
    "> ```",
    "",
    ...items,
    `- ## Long item`,
    "",
    `  ${words("li", 1500)}`,
    "",
    "The end.",
  ].join("\n");
  // Code blocks print their lines and line numbers, and a split table repeats
  // its header, so both are compared on their own.
  const leaveOut = ".milkdown-code-block, tr[data-is-header]";

  await typeDocument(page, markdown);
  await expect(page.locator(`${wysiwyg} > p`).last()).toHaveText("The end.");
  await expect(page.locator(`${wysiwyg} blockquote h2`)).toHaveCount(49);
  await expect(page.locator(`${wysiwyg} li h2`)).toHaveCount(25);
  const documentText = await printableText(page, leaveOut);

  await page.click('button[aria-label="Print"]');
  const workspace = page.locator(".print-workspace");
  await expect(page.locator(".print-page").first()).toBeVisible();
  await workspace.getByLabel("Document title in header").check();
  await workspace.getByLabel("Page numbers in footer").check();
  await expect(page.locator(".print-page").first().locator(".print-page-header")).toBeVisible();

  for (const [paper, orientation, margins, line] of [
    ["a4", "Portrait", "normal", "A4 · Portrait"],
    ["a4", "Landscape", "normal", "A4 · Landscape"],
    ["a5", "Landscape", "wide", "A5 · Landscape"],
  ] as const) {
    await workspace.getByLabel("Paper size").selectOption(paper);
    await workspace.getByRole("radio", { name: orientation, exact: true }).check();
    await workspace.getByLabel("Margins").selectOption(margins);
    await expect(workspace.locator(".print-ws-paper")).toContainText(line);

    for (const [percent, transform] of [
      [50, "matrix(0.5, 0, 0, 0.5, 0, 0)"],
      [100, "none"],
      [150, "matrix(1.5, 0, 0, 1.5, 0, 0)"],
      [200, "matrix(2, 0, 0, 2, 0, 0)"],
    ] as const) {
      const field = workspace.getByLabel("Scale", { exact: true });
      await field.fill(String(percent));
      await field.press("Enter");
      await expect(page.locator(".print-page .print-flow").first()).toHaveCSS("transform", transform);

      const { overflow, texts } = await printedSheets(page, leaveOut);
      const printedCode = await page
        .locator(".print-page .print-flow")
        .evaluateAll((flows) => flows.flatMap((flow) => Array.from(flow.querySelectorAll(".cm-line, .print-code-line"), (part) => part.textContent)));
      const at = `${line}, ${margins} margins, at ${percent}%`;
      expect.soft(overflow, `${at}: nothing reaches past its page body`).toBeLessThanOrEqual(0.5);
      expect.soft(texts.join(""), `${at}: every character prints once, in order`).toBe(documentText);
      expect.soft(printedCode, `${at}: every line of code prints once, in order`).toEqual(code);
    }
  }
});
