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

/** Replace the welcome document with `markdown`, typed into the split view's Markdown pane. */
async function typeDocument(page: import("@playwright/test").Page, markdown: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to md-easy");
  await page.click(".toolbar-view button:has-text('Split')");
  await page.locator(".editor-pane-raw .cm-content").click();
  await page.keyboard.press("Control+a");
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
  await expect(page.locator(".print-ws-paper")).toContainText("A4 · Portrait");
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

  await page.locator(".print-workspace").getByRole("radio", { name: "Markdown", exact: true }).check();
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

  await page.locator(".print-workspace").getByRole("radio", { name: "Landscape", exact: true }).check();
  const landscapeWidth = await page.evaluate(
    () => (document.querySelector(".print-page") as HTMLElement).offsetWidth,
  );
  expect(landscapeWidth).toBeGreaterThan(portraitWidth);
  await expect(page.locator(".print-ws-paper")).toContainText("A4 · Landscape");
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

test("a Hebrew or Arabic paragraph taller than a page continues on the next sheets", async ({
  page,
}) => {
  // md-easy sets no text direction, so Chromium lays a Hebrew or Arabic
  // paragraph out left to right with each line one right-to-left run, and a
  // line starts at the right end of the run. The splitter looked for a line
  // start back at the left, found none and shrank each paragraph onto one sheet.
  const hebrew = ["שלום", "עולם", "ספר", "מילה", "בית", "ילד", "מים", "אור", "דרך", "לב"];
  const arabic = ["مرحبا", "عالم", "كتاب", "كلمة", "بيت", "ولد", "ماء", "نور", "طريق", "قلب"];
  const words = (list: string[], count: number): string =>
    Array.from({ length: count }, (_, i) => list[i % list.length]).join(" ");
  const markdown = [
    "# RTL",
    "",
    `${words(hebrew, 1200)} **${words(hebrew, 300)}** \`קוד\` ${words(hebrew, 1500)} סוף`,
    "",
    `${words(arabic, 2000)} نهاية`,
    "",
    "The end.",
  ].join("\n");

  await typeDocument(page, markdown);
  await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
  const documentText = await printableText(page);

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-page").first()).toBeVisible();

  const result = await page.evaluate(() => {
    let overflow = 0;
    const texts: string[] = [];
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".print-page"));
    for (const sheet of sheets) {
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      const box = body.getBoundingClientRect();
      const scale = box.height / body.offsetHeight;
      const flow = sheet.querySelector<HTMLElement>(".print-flow")!;
      for (const block of Array.from(flow.children)) {
        overflow = Math.max(overflow, (block.getBoundingClientRect().bottom - box.top) / scale - body.clientHeight);
      }
      texts.push(flow.textContent!.replace(/\s+/g, ""));
    }
    const sheetsWith = (word: string): number => texts.filter((text) => text.includes(word)).length;
    return {
      overflow,
      text: texts.join(""),
      shrunk: document.querySelectorAll(".print-page .print-fit").length,
      hebrewSheets: sheetsWith("עולם"),
      arabicSheets: sheetsWith("عالم"),
    };
  });

  // Each paragraph continues over several sheets at its own size.
  expect(result.shrunk).toBe(0);
  expect(result.hebrewSheets).toBeGreaterThan(2);
  expect(result.arabicSheets).toBeGreaterThan(1);
  // No block reaches past its page body, and every character prints once, in order.
  expect(result.overflow).toBeLessThanOrEqual(0.5);
  expect(result.text).toBe(documentText);
});

test("a sheet of nothing but bold text fits its page where bold text is wider", async ({ page }) => {
  // The splitter confirms each piece of a paragraph in a trial copy. The copy
  // of a piece wholly inside bold text left the bold out and was measured in
  // plain text, so where the bold face is wider than the regular one, as in
  // DejaVu Sans, the piece ran up to 75 px past the page. Wide letter spacing
  // on bold text stands in for such a font.
  const words = (label: string, count: number): string =>
    Array.from({ length: count }, (_, i) => `${label}${i + 1}`).join(" ");
  await typeDocument(page, ["# Bold", "", `${words("w", 100)} **${words("bold", 1500)}**`, "", "The end."].join("\n"));
  await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
  const documentText = await printableText(page);
  await page.addStyleTag({ content: ".print-doc strong { letter-spacing: 0.15em; }" });

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-page").first()).toBeVisible();

  const { overflow, texts } = await printedSheets(page);
  // Several sheets hold bold text only, between the plain text and the end.
  const boldOnly = await page.locator(".print-page .print-flow").evaluateAll((flows) =>
    flows.filter((flow) => flow.children.length === 1 && flow.firstElementChild!.childNodes.length === 1 && flow.querySelector(":scope > p > strong")).length,
  );
  expect(boldOnly).toBeGreaterThan(1);
  expect(overflow).toBeLessThanOrEqual(0.5);
  expect(texts.join("")).toBe(documentText);
});

test("a heading taller than a page fits each sheet when printed below 100%", async ({ page }) => {
  // Below 100% the page's flow is scaled down, and the top margin of the
  // first block on a sheet collapsed through the flow at full size. The
  // paginator had made room for it at the smaller size, so each piece of a
  // long heading ran 5.7 px past its page body at 50%.
  const words = Array.from({ length: 500 }, (_, i) => `w${i + 1}`).join(" ");
  await typeDocument(page, [`# ${words}`, "", "The end."].join("\n"));
  await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
  const documentText = await printableText(page);

  await page.click('button[aria-label="Print"]');
  await expect(page.locator(".print-page").first()).toBeVisible();
  const workspace = page.locator(".print-workspace");
  await workspace.getByLabel("Document title in header").check();
  const scale = workspace.getByLabel("Scale", { exact: true });
  await scale.fill("50");
  await scale.press("Enter");
  await expect(page.locator(".print-page .print-flow").first()).toHaveCSS("transform", "matrix(0.5, 0, 0, 0.5, 0, 0)");
  await expect(page.locator(".print-page").first().locator(".print-page-header")).toBeVisible();
  expect(await page.locator(".print-page .print-flow > h1").count()).toBeGreaterThan(1);

  const { overflow, texts } = await printedSheets(page);
  expect(overflow).toBeLessThanOrEqual(0.5);
  expect(texts.join("")).toBe(documentText);
});

test("every printed sheet holds its blocks inside the page and the document's text once, at 50%, 100% and 200%", async ({ page }) => {
  // The paginator splits, packs and shrinks blocks by measuring them, and a
  // few pixels left out anywhere put content past the page body, which cuts it
  // off. This prints documents of every kind of block that splits or shrinks,
  // with a running header and page numbers, at three scales. Wide letter
  // spacing on bold text stands in for a font with a wide bold face.
  test.setTimeout(180_000);
  const words = (label: string, count: number, from = 1): string =>
    Array.from({ length: count }, (_, i) => `${label}${from + i}`).join(" ");
  const tallImage = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60000"><rect width="100" height="60000" fill="#4a7"/></svg>',
  ).toString("base64")}`;
  const code = Array.from({ length: 150 }, (_, i) => `export const step${i + 1} = ${i + 1};`);
  const documents = {
    prose: [
      "# Print check",
      "",
      `${words("w", 100)} **${words("bold", 1200)}** [${words("link", 40)}](https://example.com/long) ` +
        `*${words("em", 60)}* \`code\` ${words("v", 400)} END_PARA`,
      "",
      // Headings near a page tall at one scale or another: the 79-word one
      // is 884 px at 100%, in a 903 px page body.
      `## ${words("a", 38, 0)}`,
      "",
      `## ${words("b", 79, 0)}`,
      "",
      `## ${words("c", 165, 0)}`,
      "",
      `# ${words("d", 500)}`,
      "",
      "The end.",
    ],
    blocks: [
      "# Blocks",
      "",
      "> Quote start.",
      ">",
      ...Array.from({ length: 60 }, (_, i) => `> > nested ${i + 1}\n> >`),
      `> ${words("q", 900)} END_QUOTE`,
      "",
      "- Short item",
      `- ${words("item", 1200)} END_ITEM`,
      ...Array.from({ length: 40 }, (_, i) => `- item ${i + 1}`),
      "",
      "Notes[^short] and[^long].",
      "",
      // 28 paragraphs fill a page by themselves at 100%, but not below the label.
      `[^short]: ${Array.from({ length: 28 }, (_, i) => `Note paragraph ${i + 1}.`).join("\n\n    ")}`,
      "",
      `[^long]: ${words("n", 1500)}`,
      "",
      "| Feature | Behaviour |",
      "| --- | --- |",
      ...Array.from({ length: 80 }, (_, i) => `| row${i} | value ${i} |`),
      "",
      "```ts",
      ...code,
      "```",
      "",
      `![tall](${tallImage})`,
      "",
      "The end.",
    ],
  };
  // Code blocks print their lines and line numbers, and a split table repeats
  // its header, so both are compared on their own.
  const leaveOut = ".milkdown-code-block, tr[data-is-header]";

  for (const [name, lines] of Object.entries(documents)) {
    await test.step(name, async () => {
      await typeDocument(page, lines.join("\n"));
      await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
      await expect
        .poll(() => page.locator(`${wysiwyg} img`).evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalHeight > 0)))
        .toBe(true);
      const documentText = await printableText(page, leaveOut);
      await page.addStyleTag({ content: ".print-doc strong { letter-spacing: 0.15em; }" });
      await page.click('button[aria-label="Print"]');
      const workspace = page.locator(".print-workspace");
      await expect(page.locator(".print-page").first()).toBeVisible();
      await workspace.getByLabel("Document title in header").check();
      await expect(page.locator(".print-page").first().locator(".print-page-header")).toBeVisible();

      for (const [percent, transform] of [
        [100, "none"],
        [50, "matrix(0.5, 0, 0, 0.5, 0, 0)"],
        [200, "matrix(2, 0, 0, 2, 0, 0)"],
      ] as const) {
        const field = workspace.getByLabel("Scale", { exact: true });
        await field.fill(String(percent));
        await field.press("Enter");
        await expect(page.locator(".print-page .print-flow").first()).toHaveCSS("transform", transform);

        const { overflow, texts } = await printedSheets(page, leaveOut);
        const pieces = await page.locator(".print-page .print-flow").evaluateAll((flows) => ({
          code: flows.flatMap((flow) => Array.from(flow.querySelectorAll(".cm-line, .print-code-line"), (line) => line.textContent)),
          headerless: flows.flatMap((flow) => Array.from(flow.querySelectorAll("table"))).filter((table) => table.querySelectorAll("tr[data-is-header]").length !== 1).length,
          lonelyLabels: flows.flatMap((flow) => Array.from(flow.querySelectorAll("dt"))).filter((term) => !term.nextElementSibling?.textContent?.trim()).length,
        }));
        const at = `${name} at ${percent}%`;
        expect.soft(overflow, `${at}: nothing reaches past its page body`).toBeLessThanOrEqual(0.5);
        expect.soft(texts.join(""), `${at}: every character prints once, in order`).toBe(documentText);
        if (name === "blocks") {
          expect.soft(pieces.code, `${at}: every line of code prints once, in order`).toEqual(code);
          expect.soft(pieces.headerless, `${at}: every piece of the table has its header`).toBe(0);
          expect.soft(pieces.lonelyLabels, `${at}: each footnote label prints with its note`).toBe(0);
        }
      }
      await page.keyboard.press("Escape");
      await expect(workspace).toBeHidden();
    });
  }
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
