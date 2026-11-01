import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebContentsPrintOptions } from "electron";

// Real Chromium layout of the print workspace's sheets (spec §5.21), on the
// fonts of each platform CI runs on, and the hand-off to the native printer.

const root = path.resolve(import.meta.dirname, "..");
const wysiwyg = ".milkdown .ProseMirror";
let directory: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(async () => {
  await mkdir(path.join(root, "dev-temp", "electron-print"), { recursive: true });
  directory = await mkdtemp(path.join(root, "dev-temp", "electron-print", "run-"));
  await mkdir(path.join(directory, "profile"));
});

test.afterEach(async ({}, testInfo) => {
  await close();
  // Keep a failed run's profile and document for inspection. A file another
  // process still holds must not fail a test that passed.
  if (testInfo.status === testInfo.expectedStatus) await rm(directory, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
});

/** Launch the real app with `markdown` as its document and `settings` added
 *  to a disposable profile, and wait for its ready state. */
async function launch(markdown: string, settings = ""): Promise<void> {
  await writeFile(path.join(directory, "profile", "settings.toml"),
    `hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckEnabled = false\n${settings}`);
  const file = path.join(directory, "print.md");
  await writeFile(file, markdown);
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !["ELECTRON_RUN_AS_NODE", "DOWNPAD_DEV_URL"].includes(entry[0]),
  ));
  const executablePath = process.env.DOWNPAD_EXECUTABLE;
  app = await electron.launch({
    chromiumSandbox: true, executablePath, cwd: root,
    args: [...(executablePath ? [] : [path.join(root, "electron-dist", "main.js")]), file],
    env: { ...environment, DOWNPAD_USER_DATA_DIR: path.join(directory, "profile") },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
}

/** Close only this test's app, discarding any edits to its synthetic document. */
async function close(): Promise<void> {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {});
  await app.close();
  app = undefined;
}

/** Open the print workspace from the toolbar and wait for its first sheet. */
async function openPrint(): Promise<void> {
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-workspace .print-page").first()).toBeVisible();
}

/**
 * How far anything on the printed sheets reaches past its page body, in page
 * px: a block, a block shrunk to fit inside its frame, or a line of text. Also
 * the sheets' visible text, without whitespace, leaving out what `leaveOut`
 * matches.
 */
function printedSheets(leaveOut = ""): Promise<{ overflow: number; texts: string[] }> {
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
function printableText(leaveOut = ""): Promise<string> {
  return page.locator(wysiwyg).evaluate((node, leaveOut) => {
    const copy = node.cloneNode(true) as HTMLElement;
    if (leaveOut) copy.querySelectorAll(leaveOut).forEach((left) => left.remove());
    copy.querySelectorAll<HTMLElement>(".md-link-url").forEach((url) => {
      url.textContent = ` (${url.dataset.url})`;
    });
    return copy.textContent!.replace(/\s+/g, "");
  }, leaveOut);
}

test("every printed sheet holds its blocks inside the page and the document's text once, at 50%, 100% and 200%", async () => {
  // The paginator splits, packs and shrinks blocks by measuring them, and a
  // few pixels left out anywhere put content past the page body, which cuts it
  // off. This prints documents of every kind of block that splits or shrinks,
  // with a running header and page numbers, at three scales. Wide letter
  // spacing on bold text stands in for a font with a wide bold face.
  test.setTimeout(150_000);
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
      // Headings of 38, 79 and 165 words come close to a page's height at one
      // scale or another, on each platform's fonts.
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
  // Only the 60,000 px image is taller than a page at every scale. Everything
  // else must split rather than shrink.
  const shrunk = { prose: 0, blocks: 1 };

  for (const [name, lines] of Object.entries(documents) as [keyof typeof documents, string[]][]) {
    await test.step(name, async () => {
      await close();
      await launch(lines.join("\n") + "\n", "printHeaderTitle = true\n");
      await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
      await expect
        .poll(() => page.locator(`${wysiwyg} img`).evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalHeight > 0)))
        .toBe(true);
      const documentText = await printableText(leaveOut);
      await page.addStyleTag({ content: ".print-doc strong { letter-spacing: 0.15em; }" });
      await openPrint();
      const workspace = page.locator(".print-workspace");
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

        const { overflow, texts } = await printedSheets(leaveOut);
        const pieces = await page.locator(".print-page .print-flow").evaluateAll((flows) => ({
          code: flows.flatMap((flow) => Array.from(flow.querySelectorAll(".cm-line, .print-code-line"), (line) => line.textContent)),
          headerless: flows.flatMap((flow) => Array.from(flow.querySelectorAll("table"))).filter((table) => table.querySelectorAll("tr[data-is-header]").length !== 1).length,
          lonelyLabels: flows.flatMap((flow) => Array.from(flow.querySelectorAll("dt"))).filter((term) => !term.nextElementSibling?.textContent?.trim()).length,
          boldOnly: flows.filter((flow) => flow.children.length === 1 && flow.firstElementChild!.childNodes.length === 1 && flow.querySelector(":scope > p > strong")).length,
          tableSheets: flows.filter((flow) => flow.querySelector("table")).length,
          longHeadingPieces: flows.flatMap((flow) => Array.from(flow.querySelectorAll(":scope > h1"))).filter((heading) => /\bd\d+\b/.test(heading.textContent!)).length,
        }));
        const at = `${name} at ${percent}%`;
        expect.soft(overflow, `${at}: nothing reaches past its page body`).toBeLessThanOrEqual(0.5);
        expect.soft(texts.join(""), `${at}: every character prints once, in order`).toBe(documentText);
        expect.soft(await page.locator(".print-page .print-fit").count(), `${at}: only what no page can hold is shrunk`).toBe(shrunk[name]);
        if (name === "prose") {
          expect.soft(pieces.longHeadingPieces, `${at}: the long heading continues on the next sheet`).toBeGreaterThan(1);
          // Sheets of nothing but the wide bold text, measured as bold.
          if (percent !== 50) expect.soft(pieces.boldOnly, `${at}: sheets hold only bold text`).toBeGreaterThan(1);
        }
        if (name === "blocks") {
          expect.soft(pieces.code, `${at}: every line of code prints once, in order`).toEqual(code);
          expect.soft(pieces.headerless, `${at}: every piece of the table has its header`).toBe(0);
          expect.soft(pieces.lonelyLabels, `${at}: each footnote label prints with its note`).toBe(0);
          expect.soft(pieces.tableSheets, `${at}: the table continues on the next sheet`).toBeGreaterThan(1);
        }
      }
      await page.keyboard.press("Escape");
      await expect(workspace).toBeHidden();
    });
  }
});

test("a Hebrew or Arabic paragraph taller than a page continues on the next sheets", async () => {
  // Downpad sets no text direction, so Chromium lays a Hebrew or Arabic
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

  await launch(markdown + "\n");
  await expect(page.locator(`${wysiwyg} p`).last()).toHaveText("The end.");
  const documentText = await printableText();
  await openPrint();

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

test("printing from the Markdown view still prints the formatted document", async () => {
  // With no document view on screen, Print renders the file in a temporary
  // editor off screen and prints from that.
  await launch("# Shopping list\n\n- Apples\n- Pears\n\n```ts\nconst total = 2;\n```\n");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("# Shopping list");
  await expect(page.locator(".editor-pane-wysiwyg")).toBeHidden();
  // Record the temporary editor, so the test fails if Print takes another path.
  await page.evaluate(() => {
    new MutationObserver((changes) => {
      if (changes.some((change) => Array.from(change.addedNodes).some((node) => node instanceof Element && node.matches(".print-offscreen")))) {
        Reflect.set(window, "printedOffscreen", true);
      }
    }).observe(document.body, { childList: true });
  });
  await page.keyboard.press("ControlOrMeta+p");
  const workspace = page.locator(".print-workspace");
  await expect(workspace.locator(".print-page").first()).toBeVisible();
  await expect(workspace.getByRole("radio", { name: "Document", exact: true })).toBeEnabled();
  await expect(workspace.getByRole("radio", { name: "Document", exact: true })).toBeChecked();
  const sheet = workspace.locator(".print-page .print-doc");
  await expect(sheet.locator("h1")).toHaveText("Shopping list");
  await expect(sheet.locator("li")).toHaveText(["Apples", "Pears"]);
  await expect(sheet.locator(".cm-line, .print-code-line")).toHaveText(["const total = 2;"]);
  await expect(workspace.locator(".print-src-line")).toHaveCount(0);
  await expect(workspace).not.toContainText("# Shopping list");
  // Print rendered the document in the temporary editor, which is gone once
  // the preview shows.
  expect(await page.evaluate(() => Reflect.get(window, "printedOffscreen"))).toBe(true);
  await expect(page.locator(".print-offscreen")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(workspace).toBeHidden();
  await expect(page.locator(".print-offscreen")).toHaveCount(0);
});

test("Print hands the chosen setup to the printer, closes when it prints, and stays open to retry when it fails", async () => {
  const rows = Array.from({ length: 120 }, (_, index) => `| Row ${index + 1} | Value ${index + 1} |`);
  await launch(["# Printer check", "", "| Item | Value |", "| --- | --- |", ...rows, ""].join("\n"));
  // Stand in for a printer, so no job reaches a real one. The stub answers the
  // way Electron's callback does, failing the first job and printing the second.
  await app!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const jobs: WebContentsPrintOptions[] = [];
    Reflect.set(globalThis, "printJobs", jobs);
    contents.getPrintersAsync = async () => [{ name: "Test printer", displayName: "Test printer", description: "", options: {} }];
    contents.print = (options, callback) => {
      jobs.push(options ?? {});
      setTimeout(() => callback?.(jobs.length > 1, jobs.length > 1 ? "" : "Printer offline"), 100);
    };
  });
  const jobs = () => app!.evaluate(() => Reflect.get(globalThis, "printJobs") as WebContentsPrintOptions[]);
  await openPrint();
  const workspace = page.locator(".print-workspace");
  await expect.poll(() => workspace.locator(".print-page").count()).toBeGreaterThan(2);
  await workspace.getByLabel("Printer", { exact: true }).selectOption("Test printer");
  const copies = workspace.getByLabel("Copies", { exact: true });
  await copies.fill("2");
  await copies.press("Enter");
  await workspace.getByLabel("Paper size", { exact: true }).selectOption("letter");
  await workspace.getByRole("radio", { name: "Landscape", exact: true }).check();
  await workspace.getByLabel("Pages", { exact: true }).selectOption("custom");
  await workspace.getByPlaceholder("1-3, 5").fill("2-3");
  await workspace.getByPlaceholder("1-3, 5").press("Enter");
  const print = workspace.locator(".print-ws-footer").getByRole("button", { name: "Print", exact: true });

  await print.click();
  await expect.poll(async () => (await jobs()).length).toBe(1);
  expect((await jobs())[0]).toEqual({
    silent: true,
    printBackground: true,
    deviceName: "Test printer",
    copies: 2,
    landscape: true,
    margins: { marginType: "none" },
    scaleFactor: 100,
    header: "",
    footer: "",
    pageRanges: [{ from: 1, to: 2 }],
    // Letter in micrometres, portrait. Electron turns it for landscape.
    pageSize: { width: 215_900, height: 279_400 },
  });
  // The failed job hands the sheets back to the preview, says why it failed and
  // lets the user retry.
  await expect(page.locator("html")).not.toHaveClass(/\bprinting\b/);
  await expect(workspace).toBeVisible();
  await expect(workspace.locator(".print-ws-status")).toHaveText("Printer offline");
  await expect(workspace.locator(".print-page").first()).toBeVisible();
  await expect(print).toBeEnabled();

  await print.click();
  await expect(workspace).toBeHidden();
  expect(await jobs()).toHaveLength(2);
  expect((await jobs())[1]).toEqual((await jobs())[0]);
});
