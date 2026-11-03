import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {} from "../src/ipc/bridge";

const root = path.resolve(import.meta.dirname, "..");
let directory: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(async () => {
  await mkdir(path.join(root, "dev-temp", "electron-spelling"), { recursive: true });
  directory = await mkdtemp(path.join(root, "dev-temp", "electron-spelling", "run-"));
  await mkdir(path.join(directory, "profile"));
  await writeFile(path.join(directory, "profile", "settings.toml"),
    'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckLanguages = ["en-US"]\n');
});

test.afterEach(async ({}, testInfo) => {
  await close();
  // Keep a failed run's profile and document for inspection. A file another
  // process still holds must not fail a test that passed.
  if (testInfo.status === testInfo.expectedStatus) await rm(directory, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
});

/** Launch the real app with a disposable profile and wait for its ready state. */
async function launch(markdown?: string): Promise<void> {
  const file = path.join(directory, "spelling.md");
  if (markdown !== undefined) await writeFile(file, markdown);
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
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  await app.close();
  app = undefined;
}

/** Open the spelling page through the user interface. */
async function spellingSettings(): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Spelling", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Manage dictionary…" })).toBeVisible();
  return dialog;
}

/** Locate a word, or its later copy at `occurrence`, even when syntax
 *  highlighting splits the line. `spellcheck` tells whether Chromium may check it. */
async function wordPoint(container: Locator, word: string, occurrence = 0): Promise<{ x: number; y: number; spellcheck: boolean }> {
  await container.scrollIntoViewIfNeeded();
  return container.evaluate((element, [text, occurrence]) => {
    let skip = occurrence;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let from = node.textContent!.indexOf(text); from >= 0; from = node.textContent!.indexOf(text, from + text.length)) {
        if (skip-- > 0) continue;
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + text.length);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, spellcheck: node.parentElement!.spellcheck };
      }
    }
    throw new Error(`Word not found: ${text}`);
  }, [word, occurrence] as const);
}

/** Right-click the middle of a word, or of its later copy at `occurrence`. */
async function wordMenu(container: Locator, word: string, occurrence = 0): Promise<Locator> {
  await page.keyboard.press("Escape");
  const point = await wordPoint(container, word, occurrence);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Edit", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Wait for checking without moving focus or typing a delimiter to trigger it. */
async function misspellingMenu(container: Locator, word: string): Promise<Locator> {
  await expect.poll(async () => {
    const menu = await wordMenu(container, word);
    return menu.getByRole("menuitem", { name: "Add to dictionary", exact: true }).count();
  }, { timeout: 30_000, message: "The native spelling dictionary must load and flag the misspelling." }).toBe(1);
  return page.getByRole("menu", { name: "Edit", exact: true });
}

test("spelling languages save together, survive restart, and respond to external settings changes", async () => {
  test.skip(process.platform === "darwin", "macOS owns spelling language selection.");
  await launch("# Language notes\n\nA spelling example.\n");
  let dialog = await spellingSettings();
  await dialog.getByRole("searchbox", { name: "Find a language" }).fill("Swedish");
  await dialog.getByRole("checkbox", { name: "Swedish", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });
  expect(await readFile(path.join(directory, "profile", "settings.toml"), "utf8")).toContain('spellCheckLanguages = ["en-US","sv"]');
  await close();
  await launch();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });
  dialog = await spellingSettings();
  await dialog.getByRole("checkbox", { name: "Use system languages", exact: true }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });

  await writeFile(path.join(directory, "profile", "settings.toml"),
    'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckEnabled = false\nspellCheckLanguages = ["en-GB"]\n');
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-GB"] });
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.session.spellCheckerEnabled)).toBe(false);
  dialog = await spellingSettings();
  await expect(dialog.getByRole("checkbox", { name: "Spell check", exact: true })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Spell check", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Use system languages", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const info = await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info"));
  await expect.poll(async () => (await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info"))).activeLanguages)
    .toEqual(info.systemLanguages);
});

test("normal spelling corrections preserve formatting, source, undo and zoomed menu targeting", async () => {
  await launch("# Spelling notes\n\nA **speling** example.\n");
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const strong = page.locator(".milkdown .ProseMirror strong");
  const source = page.locator(".editor-pane-raw .cm-content");
  await misspellingMenu(strong, "speling");
  await page.keyboard.press("Escape");
  // The clicked document must be corrected even when the source pane had focus.
  await source.click();
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5));
  const menu = await wordMenu(strong, "speling");
  await menu.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(strong).toHaveText("spelling");
  await expect(source).toContainText("**spelling**");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(path.join(directory, "spelling.md"), "utf8")).toContain("**spelling**");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(strong).toHaveText("speling");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(strong).toHaveText("spelling");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("custom spelling words persist and can be removed through Settings", async () => {
  // Electron also changes the OS dictionary on Windows/macOS. Profiles cannot isolate it.
  test.skip(process.platform !== "linux", "Custom dictionary mutation requires an isolated OS account outside Linux.");
  await launch("# Dictionary notes\n\nA zorblaxquendrel example.\n");
  let paragraph = page.locator(".milkdown .ProseMirror p").first();
  const menu = await misspellingMenu(paragraph, "zorblaxquendrel");
  await menu.getByRole("menuitem", { name: "Add to dictionary", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toContain("zorblaxquendrel");
  await expect((await wordMenu(paragraph, "zorblaxquendrel")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await close();
  await launch();
  const settings = await spellingSettings();
  await settings.getByRole("button", { name: "Manage dictionary…" }).click();
  const dictionary = page.getByRole("dialog", { name: "Custom dictionary", exact: true });
  await dictionary.getByRole("button", { name: "Remove zorblaxquendrel", exact: true }).click();
  await expect(dictionary.getByText("No custom words yet.", { exact: true })).toBeVisible();
  await dictionary.getByRole("textbox", { name: "New word", exact: true }).fill("snorblaxquendrel");
  await dictionary.getByRole("button", { name: "Add word", exact: true }).click();
  await expect(dictionary.getByRole("button", { name: "Remove snorblaxquendrel" })).toBeVisible();
  await dictionary.getByRole("button", { name: "Done", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toEqual(["snorblaxquendrel"]);
  paragraph = page.locator(".milkdown .ProseMirror p").first();
  await misspellingMenu(paragraph, "zorblaxquendrel");
});

test("spelling checks prose while excluding inline and fenced code in both editors", async () => {
  // The same word is flagged in prose and excluded in code in both editors.
  await launch("# Spelling notes\n\nA speling example with inlinezorblax and `inlinezorblax`.\n\n" +
    "The fencedzorblax sample:\n\n```text\nfencedzorblax\n```\n");
  /** Wait until the prose copy of `word` is flagged, then expect the code copy at `occurrence` not to be. */
  const excluded = async (prose: Locator, code: Locator, word: string, occurrence = 0): Promise<void> => {
    await misspellingMenu(prose, word);
    expect((await wordPoint(code, word, occurrence)).spellcheck, `${word} in code is not checked`).toBe(false);
    await expect((await wordMenu(code, word, occurrence)).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  };
  const document = page.locator(".milkdown .ProseMirror");
  await excluded(document.locator("p").first(), document.locator("p code"), "inlinezorblax");
  await excluded(document.locator("p").nth(1), document.locator(".cm-content"), "fencedzorblax");
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".editor-pane-raw .cm-content");
  await expect(source).toHaveAttribute("spellcheck", "false");
  await excluded(source, source, "inlinezorblax", 1);
  await excluded(source, source, "fencedzorblax", 1);
  const correction = await misspellingMenu(source, "speling");
  await correction.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(source).toContainText("A spelling example");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(source).toContainText("A speling example");

  // New syntax receives exclusions without a view rebuild or settings change.
  await source.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nA newinlinezorblax and `newinlinezorblax` example.\n\n" +
    "The newfencedzorblax sample:\n\n```text\nnewfencedzorblax\n```\n");
  await excluded(source, source, "newinlinezorblax", 1);
  await excluded(source, source, "newfencedzorblax", 1);
  await page.keyboard.press("Escape");
  const settings = await spellingSettings();
  await settings.getByRole("checkbox", { name: "Spell check", exact: true }).uncheck();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(source).toHaveAttribute("spellcheck", "false");
  await expect((await wordMenu(source, "speling")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
});

for (const layout of ["Document", "Markdown"] as const) {
  test(`${layout} checks new and edited words without a trailing space`, async () => {
    await launch("spelling\n");
    await page.getByRole("radio", { name: layout, exact: true }).click();
    const editor = page.getByRole("textbox", { name: layout === "Document" ? "Document editor" : "Markdown source editor", exact: true });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+Home");
    for (let position = 0; position < 4; position++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    await expect(editor.locator(".md-spelling-error")).toHaveText("speling");
    await page.keyboard.type("l");
    await expect(editor.locator(".md-spelling-error")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+n");
    await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
    await page.getByRole("radio", { name: layout, exact: true }).click();
    await editor.click();
    await page.keyboard.type("speling");
    await expect(editor.locator(".md-spelling-error")).toHaveText("speling");
    const menu = await wordMenu(editor, "speling");
    await menu.getByRole("menuitem", { name: "spelling", exact: true }).click();
    await expect(editor.locator(".md-spelling-error")).toHaveCount(0);
    await expect(editor).toContainText("spelling");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test(`${layout} checks loaded text and the entire document without editing it`, async () => {
    const markdown = "A spelling example.\n\n" + "A sentence with correct words.\n\n".repeat(160) + "A speling example.\n";
    await launch(markdown);
    await page.getByRole("radio", { name: layout, exact: true }).click();
    const editor = page.getByRole("textbox", { name: layout === "Document" ? "Document editor" : "Markdown source editor", exact: true });
    const firstLine = editor.locator(layout === "Document" ? "p" : ".cm-line").first();
    const menu = await wordMenu(firstLine, "spelling");
    await menu.getByRole("menuitem", { name: "Check document spelling", exact: true }).click();
    await expect(page.getByText("Spelling check complete. 1 possible misspelling marked.", { exact: true })).toBeVisible();
    expect(await readFile(path.join(directory, "spelling.md"), "utf8")).toBe(markdown);
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+End");
    await expect(editor.locator(".md-spelling-error")).toHaveText("speling");
    await page.keyboard.press("ControlOrMeta+s");
    expect(await readFile(path.join(directory, "spelling.md"), "utf8")).toBe(markdown);
  });
}

test("full checks include metadata text while ignoring YAML keys, comments and typed values", async () => {
  await launch('---\ntitlle: "speling"\npublished: false\ncommented: # speling\n---\n\nA speling example.\n');
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await expect(paragraph.locator(".md-spelling-error")).toHaveText("speling");
  let menu = await wordMenu(paragraph, "speling");
  await menu.getByRole("menuitem", { name: "Check document spelling", exact: true }).click();
  await expect(page.getByText("Spelling check complete. 2 possible misspellings marked.", { exact: true })).toBeVisible();
  const disclosure = page.getByRole("button", { name: "Frontmatter 3 fields", exact: true });
  if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
  const value = page.locator('.frontmatter-value-edit[data-line="0"]');
  await expect(value).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("md-spelling-metadata") ?? [])].map((range) => range.toString())))
    .toContain("speling");
  menu = await wordMenu(value, "speling");
  await menu.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(value).toHaveText('"spelling"');
  await expect(paragraph.locator(".md-spelling-error")).toHaveText("speling");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(value).toHaveText('"speling"');
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown source editor", exact: true });
  await expect(source.locator(".md-spelling-error")).toHaveText(["speling", "speling"]);
  menu = await wordMenu(source, "speling");
  await menu.getByRole("menuitem", { name: "Check document spelling", exact: true }).click();
  await expect(page.getByText("Spelling check complete. 2 possible misspellings marked.", { exact: true })).toBeVisible();
});

test("print previews preserve misspelled text without spelling underlines", async () => {
  await launch("A **speling** example.\n");
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await expect(paragraph.locator(".md-spelling-error")).toHaveText("speling");
  await expect(paragraph.locator(".md-spelling-error")).toHaveCSS("text-decoration-style", "wavy");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const preview = page.locator(".print-workspace .print-flow");
  await expect(preview.locator("strong")).toHaveText("speling");
  await expect(preview.locator(".md-spelling-error, [data-managed-spelling]")).toHaveCount(0);
  await expect(preview.locator("strong")).toHaveCSS("text-decoration-line", "none");
});

test("changing documents dismisses editor spelling choices", async () => {
  await launch("A speling example.\n");
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await misspellingMenu(paragraph, "speling");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("menu", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  expect(await readFile(path.join(directory, "spelling.md"), "utf8")).toBe("A speling example.\n");
});

test("native editing menus work inside Settings and its nested dictionary dialog", async () => {
  await launch("A spelling example.\n");
  const settings = await spellingSettings();
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  const font = settings.getByRole("textbox", { name: "Body font:" });
  await font.fill("Georgia");

  /** Exercise pointer targeting and Escape within the field's own modal.
   *  `clamped` says the menu cannot open at the pointer without passing the
   *  window's edge, so it must move back inside. */
  const checkMenu = async (field: Locator, dialog: Locator, text: string, clamped = false): Promise<void> => {
    await field.click({ button: "right" });
    const menu = dialog.getByRole("menu", { name: "Edit", exact: true });
    await expect(menu).toBeVisible();
    const fieldBox = (await field.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    if (clamped) {
      const past = Math.max(fieldBox.x + fieldBox.width / 2 + menuBox.width - viewport.width, fieldBox.y + fieldBox.height / 2 + menuBox.height - viewport.height);
      expect(past, "a menu at the pointer would pass the window's edge").toBeGreaterThan(0);
    }
    expect(menuBox.x).toBeLessThanOrEqual(fieldBox.x + fieldBox.width / 2 + 1);
    expect(menuBox.y).toBeLessThanOrEqual(fieldBox.y + fieldBox.height / 2 + 1);
    expect(menuBox.x + menuBox.width).toBeGreaterThan(fieldBox.x + fieldBox.width / 2);
    expect(menuBox.y + menuBox.height).toBeGreaterThan(fieldBox.y + fieldBox.height / 2);
    await menu.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(field).toBeFocused();
    expect(await field.evaluate((element) => [
      (element as HTMLInputElement).selectionStart,
      (element as HTMLInputElement).selectionEnd,
    ])).toEqual([0, text.length]);
    await field.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(field).toBeFocused();
  };

  await checkMenu(font, settings, "Georgia");
  await settings.getByRole("checkbox", { name: "Use the system accent color" }).uncheck();
  await settings.getByRole("button", { name: "Choose custom accent color" }).click();
  const accent = page.getByRole("textbox", { name: "Accent color hex" });
  await accent.fill("#aabbcc");
  await checkMenu(accent, page.locator(".accent-popover"), "#aabbcc");
  // In a small window the menu moves back inside it while still touching the pointer.
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 600));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 600]);
  await checkMenu(accent, page.locator(".accent-popover"), "#aabbcc", true);
  await page.keyboard.press("Escape");
  await settings.getByRole("tab", { name: "Spelling", exact: true }).click();
  await settings.getByRole("button", { name: "Manage dictionary…" }).click();
  const dictionary = page.getByRole("dialog", { name: "Custom dictionary", exact: true });
  const word = dictionary.getByRole("textbox", { name: "New word", exact: true });
  await word.fill("zorblaxquendrel");
  await checkMenu(word, dictionary, "zorblaxquendrel");
  await dictionary.getByRole("button", { name: "Done", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toEqual([]);
});
