import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { WebPreferences } from "electron";
import type {} from "../src/ipc/bridge";

const projectRoot = path.resolve(import.meta.dirname, "..");
const heading = ".milkdown .ProseMirror h1";
let directory: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(async () => {
  const temporaryRoot = path.join(projectRoot, "dev-temp", "electron-e2e");
  await mkdir(temporaryRoot, { recursive: true });
  directory = await mkdtemp(path.join(temporaryRoot, "run-"));
  const userData = path.join(directory, "profile");
  await mkdir(userData);
  await writeFile(path.join(userData, "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\n");
});

test.afterEach(async () => {
  if (app) {
    // Every test uses a disposable profile. Approve discarding its unsaved
    // edits so cleanup cannot wait on a native confirmation dialog.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }).catch(() => {});
    await app.close();
  }
  app = undefined;
});

async function launch(file?: string, developmentOverride?: string): Promise<void> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[0] !== "MD_EASY_DEV_URL"),
  );
  const executablePath = process.env.MD_EASY_EXECUTABLE;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath,
    cwd: projectRoot,
    args: [
      ...(executablePath ? [] : [path.join(projectRoot, "electron-dist", "main.js")]),
      ...(file ? [file] : []),
    ],
    env: {
      ...environment,
      MD_EASY_USER_DATA_DIR: path.join(directory, "profile"),
      ...(developmentOverride ? { MD_EASY_DEV_URL: developmentOverride } : {}),
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function chooseOpen(file: string): Promise<void> {
  await app!.evaluate(({ dialog }, selectedFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
  }, file);
  await page.getByRole("button", { name: "Open", exact: true }).click();
}

async function chooseSave(file: string): Promise<void> {
  await app!.evaluate(({ dialog }, selectedFile) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selectedFile });
  }, file);
}

/** The clipboard's text with line endings as "\n". Windows puts "\r\n" there. */
async function clipboardText(): Promise<string> {
  const text = await app!.evaluate(({ clipboard }) => clipboard.readText());
  return text.replace(/\r\n/g, "\n");
}

test("launching a Markdown file renders formatting and relative images in an isolated renderer", async () => {
  const file = path.join(directory, "launch.md");
  // A synthetic one-pixel PNG exercises the local image protocol.
  await writeFile(path.join(directory, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64"));
  await writeFile(file, "# Electron Markdown\n\nA **formatted** document.\n\n| Feature | Result |\n| --- | --- |\n| Open | Works |\n\n![Local image](image.png)\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Electron Markdown");
  await expect(page.locator(".ProseMirror strong")).toHaveText("formatted");
  await expect(page.locator(".ProseMirror table.children")).toContainText("Works");
  await expect.poll(() => page.locator(".ProseMirror img").evaluateAll((images) => images.some((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  await page.locator(heading).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Markdown", exact: true }).click();
  await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toContain("# Electron Markdown");
  const isolation = await page.evaluate(() => ({
    bridge: typeof window.mdEasy?.invoke,
    require: typeof Reflect.get(window, "require"),
    process: typeof Reflect.get(window, "process"),
  }));
  expect(isolation).toEqual({ bridge: "function", require: "undefined", process: "undefined" });
  const preferences = await app!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    // This runtime inspection method is absent from Electron's public typings.
    const getPreferences: unknown = Reflect.get(contents, "getLastWebPreferences");
    if (typeof getPreferences !== "function") throw new Error("Electron cannot report its window preferences.");
    const preferences: WebPreferences = getPreferences.call(contents);
    return preferences;
  });
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(preferences.sandbox).toBe(true);
  expect(await app!.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox"))).toBe(false);
  await page.screenshot({ path: path.join(directory, "electron-open.png") });
});

test("a missing local image shows its placeholder without handler errors or failed loads in print", async () => {
  const file = path.join(directory, "missing-image.md");
  await writeFile(file, "# Missing image\n\n![Gone](missing.png)\n");
  await launch();
  const errors: string[] = [];
  app!.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await chooseOpen(file);
  await expect(page.locator(".milkdown-image-block.md-image-missing")).toHaveAttribute("data-md-path", "missing.png");
  // The printed copy must not look the path up next to md-easy's own page.
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const printed = page.locator(".print-page img");
  await expect(printed).toHaveCount(1);
  await expect.poll(() => printed.evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete))).toBe(true);
  expect(errors).toEqual([]);
});

test("the renderer's Content Security Policy allows md-easy's content and blocks inline scripts and eval", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
  // Copy image converts a GIF to PNG through a blob: URL.
  const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const server = createServer((_request, response) => response.writeHead(200, { "Content-Type": "image/png" }).end(png));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The image server has no port.");
    const file = path.join(directory, "policy.md");
    await writeFile(path.join(directory, "image.png"), png);
    await writeFile(file, [
      "# Policy", "",
      "![Local](image.png)", "",
      `![Web](http://127.0.0.1:${address.port}/web.png)`, "",
      `![Embedded](data:image/gif;base64,${gif})`, "",
      "Inline $a^2$ and block math.", "",
      "$$", "\\frac{1}{2}", "$$", "",
      "```mermaid", "graph LR", "  A --> B", "```", "",
    ].join("\n"));
    // The welcome document is read from md-easy's own files.
    await writeFile(path.join(directory, "profile", "settings.toml"), "hasCheckedDefaultHandler = true\n");
    await launch();
    await expect(page.locator(heading)).toHaveText("Welcome to md-easy 👋");
    const log = await page.evaluateHandle(() => {
      const violations: string[] = [];
      const copies: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
      // Record what Copy image writes instead of using the system clipboard.
      navigator.clipboard.write = async (items) => {
        for (const item of items) for (const type of item.types) copies.push((await item.getType(type)).type);
      };
      return { violations, copies };
    });

    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(String(error)));
    await chooseOpen(file);
    const pane = page.locator(".editor-pane:not([hidden])");
    // Crepe draws a code block, and its diagram, once the block is on screen.
    await pane.locator(".milkdown-code-block").last().scrollIntoViewIfNeeded();
    await expect(pane.locator(".mermaid-preview svg")).toBeVisible().catch(async (error: Error) => {
      const violations = await log.evaluate(({ violations }) => violations);
      throw new Error(`${error.message}\nViolations: ${JSON.stringify(violations)}\nErrors: ${JSON.stringify(errors)}`);
    });
    await expect(pane.locator(".katex")).toHaveCount(2);
    await expect.poll(() => pane.locator(".ProseMirror img").evaluateAll((images) => images.map((image) => image instanceof HTMLImageElement && image.naturalWidth > 0))).toEqual([true, true, true]);
    // Copy image fetches the embedded image's data: URL and converts it to PNG.
    await pane.getByRole("img", { name: "Embedded", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
    await expect.poll(() => log.evaluate(({ copies }) => copies)).toEqual(["image/png"]);
    // Vite inlines KaTeX_Size3 as a data: URL. A blocked inlined font falls back to
    // its font file without a violation event, so load each inlined source directly.
    const inlinedFonts = await page.evaluate(() => {
      const faces = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule instanceof CSSFontFaceRule);
      return Promise.all(faces.flatMap((face) => {
        const family = face.style.getPropertyValue("font-family");
        return [...face.style.getPropertyValue("src").matchAll(/url\("?(data:[^")]+)"?\)/g)]
          .map(([, source]) => new FontFace(family, `url(${source})`).load().then(() => `${family} loaded`, () => `${family} blocked`));
      }));
    });
    expect(inlinedFonts).toEqual(["KaTeX_Size3 loaded"]);
    expect(await log.evaluate(({ violations }) => ({
      violations,
      failedFonts: [...document.fonts].filter((font) => font.status === "error").map((font) => font.family),
    }))).toEqual({ violations: [], failedFonts: [] });

    expect(await page.evaluate(() => new Promise((resolve) => {
      const script = document.createElement("script");
      script.textContent = "document.body.dataset.inlineScript = 'ran'";
      document.head.append(script);
      // Test evaluation lifts the eval block for its own call, so check from a timer.
      setTimeout(() => {
        let evaluated = true;
        try { new Function(""); } catch { evaluated = false; }
        resolve({ inlineScript: document.body.dataset.inlineScript ?? "blocked", evaluated });
      });
    }))).toEqual({ inlineScript: "blocked", evaluated: false });
  } finally {
    server.close();
  }
});

test("the packaged app ignores a remote development URL override", async () => {
  test.skip(!process.env.MD_EASY_EXECUTABLE, "This boundary requires a packaged executable.");
  const file = path.join(directory, "packaged.md");
  await writeFile(file, "# Bundled application\n");
  await launch(file, "https://example.invalid/");
  await expect(page.locator(heading)).toHaveText("Bundled application");
  expect(new URL(page.url()).protocol).toBe("file:");
  expect(await app!.evaluate(({ app }) => app.isPackaged)).toBe(true);
});

test("a toolbar tooltip lets a click through to Recent", async () => {
  const file = path.join(directory, "tooltip.md");
  await writeFile(file, "# Tooltip\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Tooltip");
  // Keyboard focus opens the menu button's tooltip over Recent, and it stays open.
  await page.getByRole("button", { name: "Application menu", exact: true }).focus();
  await expect(page.getByRole("tooltip", { name: "Menu", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recent", exact: true }).click({ timeout: 2_000 });
  await expect(page.locator(".recent-host")).toBeVisible();
});

test("a toolbar tooltip stays open while the pointer is over it", async () => {
  const file = path.join(directory, "hover.md");
  await writeFile(file, "# Hover\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Hover");
  const button = await page.getByRole("button", { name: "Print", exact: true }).boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2);
  const tooltip = page.getByRole("tooltip", { name: /^Print/ });
  await expect(tooltip).toBeVisible();
  // Clicks pass through the tooltip, but moving onto it must not close it.
  const box = await page.locator("[data-radix-popper-content-wrapper]").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.move(box!.x + box!.width - 4, box!.y + box!.height / 2, { steps: 8 });
  // Rest on the tooltip a while, so a delayed close would have happened.
  await page.waitForTimeout(800);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 150, { steps: 8 });
  await expect(tooltip).toBeHidden();
});

test("native Open, edit, Save, and external file reload use actual files", async () => {
  const file = path.join(directory, "opened.md");
  await writeFile(file, "# Opened from dialog\r\n\r\nOriginal text.\r\n");
  await launch();
  await chooseOpen(file);
  await expect(page.locator(heading)).toHaveText("Opened from dialog");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await raw.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Saved by Electron\n\nEdited content.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFile(file, "utf8")).toBe("# Saved by Electron\r\n\r\nEdited content.\r\n");
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await expect(page.locator(heading)).toHaveText("Saved by Electron");
  await writeFile(file, "# Updated outside Electron\r\n\r\nExternal edit.\r\n");
  await expect(page.getByText("This file changed on disk.")).toBeVisible();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator(heading)).toHaveText("Updated outside Electron");
});

test("Save right after typing writes the last edit in the document and split views", async () => {
  const file = path.join(directory, "typed.md");
  await writeFile(file, "# Typed\n\nFirst line.\n");
  await launch(file);
  // The document view reports typing after a short delay. Save at once, without
  // waiting for it, and the file must still get the last word.
  await page.locator(".milkdown .ProseMirror p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Saved at once.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("# Typed\n\nFirst line. Saved at once.\n");
  await expect(page).toHaveTitle("typed.md — md-easy");

  // In the split, the Markdown pane still catches up after the save.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await page.locator(".editor-pane-wysiwyg .ProseMirror p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Split too.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("# Typed\n\nFirst line. Saved at once. Split too.\n");
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("First line. Saved at once. Split too.");
  await expect(page).toHaveTitle("typed.md — md-easy");
});

test("Save with no edit leaves a file the document view would rewrite byte-identical", async () => {
  const file = path.join(directory, "unedited.md");
  // The document view writes this as "# Title\n\nLine\\\nnext\n\nSee [docs](https://x.y).\n".
  const markdown = "Title\n=====\n\nLine  \nnext\n\nSee [docs][d].\n\n[d]: https://x.y\n";
  await writeFile(file, markdown);
  const original = await stat(file);
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Title");
  await page.locator(heading).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Markdown", exact: true }).click();
  await expect.poll(clipboardText).toBe(markdown);
  await page.keyboard.press("ControlOrMeta+s");
  // Save replaces the file, so wait for the new one before reading it.
  await expect.poll(async () => (await stat(file)).ino).not.toBe(original.ino);
  expect(await readFile(file, "utf8")).toBe(markdown);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("=====");
  await expect(page).toHaveTitle("unedited.md — md-easy");
});

test("launching with a file builds its document editor once", async () => {
  const launched = path.join(directory, "launched.md");
  const later = path.join(directory, "later.md");
  await writeFile(launched, "# Launched file\n");
  await writeFile(later, "# Later file\n");
  await launch();
  // As in the reload test below, settle the first renderer's file listener.
  await page.evaluate(async () => {
    window.mdEasy!.listen("open-file-requested", () => {});
    await window.mdEasy!.invoke("settings_path");
  });
  // Count document editors from the start of a reloaded renderer, which reads
  // the first queued file as its launch argument.
  const session = await page.context().newCDPSession(page);
  await session.send("Page.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.editorBuilds = 0; new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.classList.contains('crepe-root')) window.editorBuilds++; }).observe(document, { childList: true, subtree: true });",
  });
  const reloaded = page.waitForEvent("domcontentloaded");
  await app!.evaluate(({ app, BrowserWindow }, paths) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.once("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      for (const filePath of paths) app.emit("open-file", { preventDefault: () => {} }, filePath);
    });
    contents.reload();
  }, [launched, later]);
  await reloaded;
  // The second file arrives only after startup has finished, so any second
  // build of the launched file has happened by the time it shows.
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror h1")).toHaveText("Later file");
  // One build for each file.
  expect(await page.evaluate(() => Reflect.get(window, "editorBuilds"))).toBe(2);
});

test("Open recovered shows a snapshot's exact text as unsaved", async () => {
  const file = path.join(directory, "recovered.md");
  await writeFile(file, "# Before the crash\n");
  // The document view writes this as "# Title\n\nLine\\\nnext\n\nSee [docs](https://x.y).\n".
  const markdown = "Title\n=====\n\nLine  \nnext\n\nSee [docs][d].\n\n[d]: https://x.y\n";
  const recovery = path.join(directory, "profile", "recovery");
  await mkdir(recovery);
  const snapshot = { sessionId: "earlier-session", savedAt: new Date().toISOString(), filePath: file, markdown, isDirty: true };
  await writeFile(path.join(recovery, "earlier-session.json"), JSON.stringify(snapshot));
  await launch();
  // Startup only fills the tab, so the editor must still be built for it.
  await page.getByRole("button", { name: "Open recovered", exact: true }).click();
  await expect(page.locator(heading)).toHaveText("Title");
  await expect(page).toHaveTitle("● recovered.md — md-easy");
  await page.locator(heading).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Markdown", exact: true }).click();
  await expect.poll(clipboardText).toBe(markdown);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(markdown);
  await expect(page).toHaveTitle("recovered.md — md-easy");
});

test("the first-run welcome document opens as saved with its exact text", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = false\nhasCheckedDefaultHandler = true\n");
  // The renderer reads the copy that the build puts next to index.html.
  const welcome = (await readFile(path.join(projectRoot, "dist", "welcome.md"), "utf8")).replace(/\r\n/g, "\n");
  await launch();
  await expect(page.locator(heading)).toContainText("Welcome to md-easy");
  await page.locator(heading).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Markdown", exact: true }).click();
  await expect.poll(clipboardText).toBe(welcome);
  await expect(page).toHaveTitle("Untitled — md-easy");
});

test("an undo right after Save marks the document unsaved again", async () => {
  const file = path.join(directory, "undo.md");
  // No heading: the heading-id plugin's first update would hide the case.
  await writeFile(file, "First line.\n");
  await launch(file);
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Undone.");
  await page.keyboard.press("ControlOrMeta+s");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph).toHaveText("First line.");
  // The file has the typed words but the document no longer does.
  await expect(page).toHaveTitle("● undo.md — md-easy");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\n");
  await expect(page).toHaveTitle("undo.md — md-easy");
});

test("undoing every edit marks the document saved again", async () => {
  const file = path.join(directory, "undo-all.md");
  await writeFile(file, "First line.\n");
  await launch(file);
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed.");
  await expect(page).toHaveTitle("● undo-all.md — md-easy");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph).toHaveText("First line.");
  await expect(page).toHaveTitle("undo-all.md — md-easy");
});

test("the first Ctrl+Z after opening a file that ends in a list leaves the caret in place", async () => {
  const file = path.join(directory, "undo-list.md");
  await writeFile(file, "First line.\n\n- Last item\n");
  await launch(file);
  // The document view adds an empty line after a final list, for typing below it.
  await expect(page.locator(".milkdown .ProseMirror > p")).toHaveCount(2);
  const paragraph = page.locator(".milkdown .ProseMirror > p").first();
  await paragraph.click();
  await page.keyboard.press("End");
  // There is nothing to undo yet, so the caret stays at the end of the line.
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.type("!");
  await expect(paragraph).toHaveText("First line.!");
});

test("closing a tab right after typing asks before discarding the edit", async () => {
  const file = path.join(directory, "closing.md");
  await writeFile(file, "# Closing\n\nFirst line.\n");
  await launch(file);
  // Record the unsaved-changes prompt and answer Cancel.
  await app!.evaluate(({ dialog }) => {
    const prompts: string[] = [];
    Object.assign(globalThis, { prompts });
    dialog.showMessageBox = async (...args: unknown[]) => {
      prompts.push(String((args.at(-1) as { message?: unknown }).message));
      return { response: 0, checkboxChecked: false };
    };
  });
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Not lost.");
  await page.getByRole("tab", { name: /closing\.md/ }).click({ button: "middle" });
  await expect.poll(() => app!.evaluate(() => (globalThis as { prompts?: string[] }).prompts ?? [])).toEqual([
    '"closing.md" has unsaved changes. Discard them?',
  ]);
  await expect(paragraph).toHaveText("First line. Not lost.");
});

/** Open a one-line file in the split, returning each pane's first line. */
async function openSplit(name: string): Promise<{ file: string; documentLine: Locator; markdownLine: Locator }> {
  const file = path.join(directory, name);
  await writeFile(file, "First line.\n");
  await launch(file);
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  return {
    file,
    documentLine: page.locator(".editor-pane-wysiwyg .ProseMirror p").first(),
    markdownLine: page.locator(".editor-pane-raw .cm-line").first(),
  };
}

/** Click a line, move to its end, and type there. */
async function typeAtEnd(line: Locator, text: string): Promise<void> {
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

test("Print right after typing in the split's document pane keeps the Markdown pane in step", async () => {
  const { file, documentLine, markdownLine } = await openSplit("print-document.md");
  // Open Print before the edit reaches the Markdown pane.
  await typeAtEnd(documentLine, " Document.");
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.locator(".print-workspace")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".print-workspace")).toBeHidden();
  // A Markdown pane left behind would write its old text over the document edit.
  await typeAtEnd(markdownLine, " Markdown.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Document. Markdown.\n");
  await expect(documentLine).toHaveText("First line. Document. Markdown.");
});

test("Print right after typing in the split's Markdown pane prints it and keeps the document pane in step", async () => {
  const { file, documentLine, markdownLine } = await openSplit("print-markdown.md");
  await typeAtEnd(markdownLine, " Markdown.");
  await page.keyboard.press("ControlOrMeta+p");
  // The printed document is a copy of the document pane, so it needs the edit.
  await expect(page.locator(".print-page").first()).toContainText("First line. Markdown.");
  await page.keyboard.press("Escape");
  await expect(page.locator(".print-workspace")).toBeHidden();
  // A document pane left behind would ignore this typing.
  await typeAtEnd(documentLine, " Document.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Markdown. Document.\n");
  await expect(markdownLine).toHaveText("First line. Markdown. Document.");
});

test("cancelling a window close right after typing in the split keeps both panes in step", async () => {
  const { file, documentLine, markdownLine } = await openSplit("close-split.md");
  await typeAtEnd(documentLine, " Document.");
  // Close the window and answer Cancel to the unsaved-changes prompt.
  await app!.evaluate(({ BrowserWindow, dialog }) => new Promise<void>((resolve) => {
    dialog.showMessageBox = async () => {
      resolve();
      return { response: 0, checkboxChecked: false };
    };
    BrowserWindow.getAllWindows()[0]!.close();
  }));
  await typeAtEnd(markdownLine, " Markdown.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Document. Markdown.\n");
});

test("typing in the split's Markdown pane right after the document pane keeps both edits", async () => {
  const { file, documentLine, markdownLine } = await openSplit("document-first.md");
  const box = (await markdownLine.boundingBox())!;
  await typeAtEnd(documentLine, " Document.");
  // Click the Markdown line's right edge at once, before the document pane
  // reports its typing. No End key, so the typing goes where the click put the
  // caret.
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.keyboard.type(" Markdown.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Document. Markdown.\n");
  await expect(documentLine).toHaveText("First line. Document. Markdown.");
});

test("typing in the split's document pane right after the Markdown pane keeps both edits", async () => {
  const { file, markdownLine } = await openSplit("markdown-first.md");
  await typeAtEnd(markdownLine, " Markdown.");
  // Shift+Tab moves focus straight into the document pane, before the Markdown
  // edit reaches it.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Document.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Markdown. Document.\n");
  await expect(markdownLine).toHaveText("First line. Markdown. Document.");
});

test("Print keeps a saved Markdown edit as typed", async () => {
  const { file, markdownLine } = await openSplit("bullets.md");
  await markdownLine.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("\n\n* Star bullet");
  await expect(page.locator(".editor-pane-wysiwyg .ProseMirror li")).toHaveText("Star bullet");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\n\n* Star bullet\n");
  // The document view writes bullets as "-". Printing from it must not put that
  // form in place of the saved text or mark the file unsaved.
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.locator(".print-workspace")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".print-workspace")).toBeHidden();
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("* Star bullet");
  await expect(page).toHaveTitle("bullets.md — md-easy");
});

test("the find count follows edits made while the card is open", async () => {
  const file = path.join(directory, "find-count.md");
  await writeFile(file, "Alpha zeta.\n\nMiddle line.\n\nOmega zeta.\n");
  await launch(file);
  const count = page.locator(".find-count");
  const middle = page.locator(".editor-pane-wysiwyg .ProseMirror p").filter({ hasText: "Middle line." });
  await middle.click();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in document" }).fill("zeta");
  await expect(count).toHaveText("1 of 2");

  await typeAtEnd(middle, " zeta");
  await expect(count).toHaveText("1 of 3");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count).toHaveText("1 of 2");

  // In the split, a Markdown edit reaches the count through the document pane.
  // The card covers the top lines of the Markdown pane.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await expect(count).toHaveText("1 of 2");
  const omega = page.locator(".editor-pane-raw .cm-line").filter({ hasText: "Omega zeta." });
  await typeAtEnd(omega, " zeta");
  await expect(count).toHaveText("1 of 3");

  // The Markdown view counts once typing pauses. The caret is on no match, so
  // none is current.
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(count).toHaveText("1 of 3");
  await typeAtEnd(omega, " zeta");
  await expect(count).toHaveText("0 of 4");
  // F3 selects the next match, and a click away from the matches leaves none
  // current again.
  await page.keyboard.press("F3");
  await expect(count).toHaveText("1 of 4");
  await page.locator(".editor-pane-raw .cm-line").filter({ hasText: "Middle line." }).click({ position: { x: 4, y: 4 } });
  await expect(count).toHaveText("0 of 4");
});

/** The text under each find highlight the frontmatter table paints. */
function tableHighlights(): Promise<{ match: string[]; current: string[] }> {
  return page.evaluate(() => {
    const texts = (name: string) => [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString());
    return { match: texts("md-find-match"), current: texts("md-find-current") };
  });
}

test("find in the document view searches and replaces the frontmatter table", async () => {
  const file = path.join(directory, "frontmatter-find.md");
  await writeFile(file, '---\ntitle: Draft notes # keep\nmeta:\n  status: "draft"\ntags:\n  - draft\n---\n\nThe draft body.\n');
  await launch(file);
  await expect(page.locator(".frontmatter-table")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in document" });
  const count = page.locator(".find-count");
  await find.fill("draft");
  // The table's three matches come first, as the table sits above the body.
  await expect(count).toHaveText("1 of 4");
  expect(await tableHighlights()).toEqual({ match: ["draft", "draft"], current: ["Draft"] });
  await expect(page.locator(".ProseMirror .md-find-current")).toHaveCount(0);
  for (const step of ["2 of 4", "3 of 4", "4 of 4"]) {
    await find.press("Enter");
    await expect(count).toHaveText(step);
  }
  await expect(page.locator(".ProseMirror .md-find-current")).toHaveText("draft");
  expect((await tableHighlights()).current).toEqual([]);
  // A match typed into a cell is painted as well.
  const status = page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "status", exact: true }) })
    .locator(".frontmatter-value-edit");
  await typeAtEnd(status, " draft");
  await expect.poll(async () => (await tableHighlights()).match).toEqual(["Draft", "draft", "draft", "draft"]);
  // Replace all rewrites the table's lines and leaves the read-only list item.
  await page.keyboard.press("ControlOrMeta+h");
  await page.getByRole("textbox", { name: "Replace with" }).fill("final");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(count).toHaveText("1 of 1");
  await expect.poll(tableHighlights).toEqual({ match: [], current: ["draft"] });
  await page.getByRole("button", { name: "Close find" }).click();
  expect(await tableHighlights()).toEqual({ match: [], current: [] });
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toMatch(/^---\ntitle: final notes # keep\nmeta:\n {2}status: "final" final\ntags:\n {2}- draft\n---\n\n?The final body\.\n$/);
});

test("the frontmatter table's find highlights go with a layout change or a tab switch", async () => {
  const file = path.join(directory, "frontmatter-find-clear.md");
  await writeFile(file, "---\ntitle: Draft notes\n---\n\nThe draft body.\n");
  await launch(file);
  await expect(page.locator(".frontmatter-table")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in document" }).fill("draft");
  const count = page.locator(".find-count");
  await expect(count).toHaveText("1 of 2");
  expect(await tableHighlights()).toEqual({ match: [], current: ["Draft"] });
  // The card stays open and searches the Markdown source, which has no table.
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .md-find-current")).toHaveText("Draft");
  expect(await tableHighlights()).toEqual({ match: [], current: [] });
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await expect.poll(tableHighlights).toEqual({ match: [], current: ["Draft"] });
  // A new tab closes the card.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page).toHaveTitle("Untitled — md-easy");
  expect(await tableHighlights()).toEqual({ match: [], current: [] });
});

test("closing find on a frontmatter match leaves the caret there", async () => {
  const file = path.join(directory, "frontmatter-find-close.md");
  await writeFile(file, "---\ntitle: Draft notes\n---\n\nFirst paragraph.\n\nThe draft body.\n");
  await launch(file);
  await expect(page.locator(".frontmatter-table")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in document" });
  const count = page.locator(".find-count");
  await find.fill("draft");
  await expect(count).toHaveText("1 of 2");
  // Step past the body's match and around to the title, then close the card.
  await find.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await find.press("Enter");
  await expect(count).toHaveText("1 of 2");
  await find.press("Escape");
  // Typing replaces the title's match, as it would a match in the document.
  await page.keyboard.type("Final");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toMatch(/^---\ntitle: Final notes\n---\n\n?First paragraph\.\n\nThe draft body\.\n$/);
});

test("Escape closes find after Replace all removes the last match", async () => {
  const file = path.join(directory, "replace-all-escape.md");
  await writeFile(file, "Alpha zeta.\n\nOmega zeta.\n");
  await launch(file);
  const card = page.locator(".find-bar");
  const find = page.getByRole("textbox", { name: "Find in document" });
  const count = page.locator(".find-count");
  for (const [view, query, replacement] of [["Document", "zeta", "eta"], ["Markdown", "eta", "nu"]] as const) {
    await page.getByRole("radio", { name: view, exact: true }).click();
    await page.keyboard.press("ControlOrMeta+h");
    await find.fill(query);
    await page.getByRole("textbox", { name: "Replace with" }).fill(replacement);
    await expect(count).toHaveText(/ of 2$/);
    // The click focuses Replace all, which no match left disables.
    await page.getByRole("button", { name: "Replace all" }).click();
    await expect(count).toHaveText("No results");
    await expect(find).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
  }
});

test("a file that ends in a list opens as saved", async () => {
  const file = path.join(directory, "list-end.md");
  await writeFile(file, "First line.\n\n- Last item\n");
  await launch(file);
  // The document view adds an empty line after a final list, for typing below it.
  await expect(page.locator(".milkdown .ProseMirror > p")).toHaveCount(2);
  // Switching views reports any document change at once.
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText("- Last item");
  await expect(page).toHaveTitle("list-end.md — md-easy");
});

test("pasting a copy of the whole document adds no empty line", async () => {
  const file = path.join(directory, "copy-all.md");
  await writeFile(file, "Intro.\n\n> Quote\n");
  await launch(file);
  const intro = page.locator(".milkdown .ProseMirror > p").first();
  await intro.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboardText).toBe("Intro.\n\n> Quote\n");
  // The document view keeps an empty line after the final quote. The copy's
  // HTML, which a paste reads, must leave it out too.
  await typeAtEnd(intro, "\n");
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro.\n\nIntro.\n\n> Quote\n\n> Quote\n");
});

test("an edit to a file that ends in a code block saves no extra blank line", async () => {
  const file = path.join(directory, "code-end.md");
  await writeFile(file, "First line.\n\n```js\nlet x = 1;\n```\n");
  await launch(file);
  const paragraph = page.locator(".milkdown .ProseMirror > p").first();
  // The document view adds an empty line after a final code block, for typing
  // below it. Neither that line nor a click marks the file unsaved.
  await paragraph.click();
  await expect(page.locator(".milkdown .ProseMirror > p")).toHaveCount(2);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page).toHaveTitle("code-end.md — md-easy");
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await typeAtEnd(paragraph, " Edited.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Edited.\n\n```js\nlet x = 1;\n```\n");
});

test("find scrolls to each match and highlights matches inside code blocks", async () => {
  const file = path.join(directory, "find.md");
  const filler = Array.from({ length: 60 }, (_, index) => `Filler paragraph ${index + 1}.`).join("\n\n");
  // A 300-line code block whose match ends a line too long for the block, which
  // scrolls sideways.
  const code = (match: number) => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
    lines[match - 1] += ` ${"x".repeat(200)} needle`;
    return ["```text", ...lines, "```"].join("\n");
  };
  // A table wider than the page, which scrolls the page sideways, with the
  // match in its last column.
  const columns = Array.from({ length: 14 }, (_, index) => index + 1);
  const table = [
    `| ${columns.map((column) => `Column${column}heading`).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    `| ${columns.map((column) => (column === 14 ? "needle" : `value${column}value`)).join(" | ")} |`,
  ].join("\n");
  // The first code block is drawn at once, but only its first lines. The second
  // is drawn only when it nears the screen.
  const blocks = ["# Find", "Intro needle.", code(120), filler, table, filler, code(250), filler, "Last needle."];
  await writeFile(file, blocks.join("\n\n") + "\n");
  await launch(file);
  await page.locator(heading).click();
  // Control on every platform, because Cmd+H hides the app on macOS.
  await page.keyboard.press("Control+h");
  const input = page.getByRole("textbox", { name: "Find in document" });
  const count = page.locator(".find-count");
  const current = page.locator(".md-find-current");
  const inCodeBlock = page.locator(".milkdown-code-block .md-find-current");
  const inParagraph = page.locator(".milkdown .ProseMirror > p .md-find-current");
  const inTable = page.locator(".milkdown td .md-find-current");

  await input.fill("needle");
  await expect(count).toHaveText("1 of 5");
  await expect(inParagraph).toBeInViewport({ ratio: 1 });
  // A match on screen leaves the page where it is.
  expect(await page.locator(".editor-area").evaluate((area) => area.scrollTop)).toBe(0);

  await input.press("Enter");
  await expect(count).toHaveText("2 of 5");
  await expect(inCodeBlock).toHaveText("needle");
  await expect(inCodeBlock).toBeInViewport({ ratio: 1 });

  await input.press("Enter");
  await expect(count).toHaveText("3 of 5");
  await expect(inTable).toHaveText("needle");
  await expect(inTable).toBeInViewport({ ratio: 1 });

  await input.press("Enter");
  await expect(count).toHaveText("4 of 5");
  await expect(inCodeBlock).toHaveText("needle");
  await expect(inCodeBlock).toBeInViewport({ ratio: 1 });

  await input.press("Enter");
  await expect(count).toHaveText("5 of 5");
  await expect(inParagraph).toHaveText("needle");
  await expect(inParagraph).toBeInViewport({ ratio: 1 });

  // Back to the first match at the top.
  await input.press("Enter");
  await expect(count).toHaveText("1 of 5");
  await expect(inParagraph).toBeInViewport({ ratio: 1 });

  // Replace in the second code block. CodeMirror then scrolls to its own cursor
  // in that block, and whichever match Replace makes current must stay in view.
  await input.press("Shift+Enter");
  await input.press("Shift+Enter");
  await expect(count).toHaveText("4 of 5");
  await expect(inCodeBlock).toBeInViewport({ ratio: 1 });
  await page.getByRole("textbox", { name: "Replace with" }).fill("pin");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(count).toHaveText(/ of 4$/);
  await expect(current).toBeInViewport({ ratio: 1 });
});

test("the document page runs to the end of a long document", async () => {
  const file = path.join(directory, "long.md");
  const paragraphs = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}.`);
  await writeFile(file, ["# Long document", ...paragraphs].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Long document");
  const bottoms = await page.locator(".editor-area").evaluate((area) => {
    area.scrollTop = area.scrollHeight;
    const bottom = (selector: string) => area.querySelector(selector)!.getBoundingClientRect().bottom;
    return { scrolled: area.scrollTop > 0, view: area.getBoundingClientRect().bottom, page: bottom(".editor-column"), text: bottom(".milkdown") };
  });
  expect(bottoms.scrolled).toBe(true);
  // Scrolled to the end, the page holds all of the text and ends with the view.
  expect(bottoms.page).toBeGreaterThan(bottoms.text);
  expect(Math.round(bottoms.page)).toBe(Math.round(bottoms.view));
});

test("the document page fills the window for a short document", async () => {
  const file = path.join(directory, "short.md");
  await writeFile(file, "# Short document\n\nOne paragraph.\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Short document");
  const bottoms = await page.locator(".editor-area").evaluate((area) => ({
    view: area.getBoundingClientRect().bottom,
    page: area.querySelector(".editor-column")!.getBoundingClientRect().bottom,
  }));
  expect(Math.round(bottoms.page)).toBe(Math.round(bottoms.view));
});

test("an edit in the document view keeps the blank line after the frontmatter", async () => {
  const file = path.join(directory, "frontmatter.md");
  await writeFile(file, "---\ntitle: x\n---\n\nFirst line.\n");
  await launch(file);
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").first(), " Typed.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("---\ntitle: x\n---\n\nFirst line. Typed.\n");
});

test("text typed after frontmatter that ends the file starts a new line", async () => {
  const file = path.join(directory, "frontmatter-only.md");
  // Saved without a final newline, as some editors do.
  await writeFile(file, "---\ntitle: x\n---");
  await launch(file);
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").first(), "Hello");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("---\ntitle: x\n---\nHello\n");
});

test("lists typed in the document view save an item nested by Tab without a blank line", async () => {
  const file = path.join(directory, "typed-lists.md");
  await writeFile(file, "Start.\n\nMiddle.\n");
  await launch(file);
  // Crepe puts the cursor back into a new list item one frame after drawing it,
  // so wait for that frame before typing in the item.
  const typeInNewItem = async (text: string) => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await page.keyboard.type(text);
  };
  // A bullet list started by typing "- ".
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").filter({ hasText: "Start." }), "\n- ");
  await typeInNewItem("A");
  await page.keyboard.press("Enter");
  await typeInNewItem("B");
  await page.keyboard.press("Tab");
  // A task list started from the slash menu.
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").filter({ hasText: "Middle." }), "\n/");
  await page.locator(".milkdown-slash-menu li").filter({ hasText: "Task List" }).click();
  await typeInNewItem("C");
  await page.keyboard.press("Enter");
  await typeInNewItem("D");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Start.\n\n- A\n  - B\n\nMiddle.\n\n- [ ] C\n  - [ ] D\n");
});

test("a rule typed under a list item's text saves with a blank line before it", async () => {
  const file = path.join(directory, "rule-in-item.md");
  await writeFile(file, "Start.\n");
  await launch(file);
  // Wait for Crepe to put the cursor back into each new item, as above.
  const nextFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").filter({ hasText: "Start." }), "\n- ");
  await nextFrame();
  await page.keyboard.type("A");
  await page.keyboard.press("Enter");
  await nextFrame();
  // Backspace makes the new item a second line of the first, where "---" adds a rule.
  await page.keyboard.press("Backspace");
  await page.keyboard.type("---");
  await page.keyboard.press("ControlOrMeta+s");
  // Without the blank line, the file would read back with "A" as a heading and no rule.
  await expect.poll(() => readFile(file, "utf8")).toBe("Start.\n\n- A\n\n  ---\n");
});

test("the print workspace exports a real PDF and preserves landscape and page ranges", async () => {
  const file = path.join(directory, "print.md");
  const rows = Array.from({ length: 90 }, (_, index) => `| Row ${index + 1} | Value ${index + 1} |`);
  await writeFile(file, ["# Printable Markdown", "", "| Item | Value |", "| --- | --- |", ...rows, ""].join("\n"));
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Printable Markdown");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect.poll(() => page.locator(".print-page").count()).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(directory, "electron-print.png") });
  const pdf = path.join(directory, "document.pdf");
  await chooseSave(pdf);
  await page.getByRole("button", { name: "Save as PDF", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeHidden({ timeout: 30_000 });
  expect((await readFile(pdf)).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.locator(".print-workspace").getByRole("radio", { name: "Landscape", exact: true }).check();
  await page.getByLabel("Pages", { exact: true }).selectOption("custom");
  await page.getByPlaceholder("1-3, 5").fill("1");
  await page.getByPlaceholder("1-3, 5").press("Tab");
  const landscapePdf = path.join(directory, "landscape-first-page.pdf");
  await chooseSave(landscapePdf);
  await page.getByRole("button", { name: "Save as PDF", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => {
    try { return (await readFile(landscapePdf)).subarray(0, 5).toString(); }
    catch { return ""; }
  }).toBe("%PDF-");
});

test("the empty line after a final list adds no blank sheet to the print", async () => {
  const file = path.join(directory, "full-sheet.md");
  const paragraphs = Array.from({ length: 28 }, (_, index) => `Paragraph ${index + 1}.`);
  await writeFile(file, [...paragraphs, "---", "- Last item"].join("\n\n") + "\n");
  await launch(file);
  // The document view adds an empty line after a final list, for typing below it.
  await expect(page.locator(".milkdown .ProseMirror > p").last()).toHaveText("");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const firstSheet = page.locator(".print-page").first();
  await expect(firstSheet).toContainText("Last item");
  // The list ends closer to the bottom of the sheet than that empty line is tall.
  const roomBelowList = await firstSheet.evaluate((sheet) => {
    const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
    const list = sheet.querySelector<HTMLElement>(".print-flow > ul")!;
    return body.offsetHeight - (list.offsetTop + list.offsetHeight);
  });
  expect(roomBelowList).toBeLessThan(8);
  await expect(page.locator(".print-page")).toHaveCount(1);
});

test("Print submits the document to an installed test printer", async () => {
  const printer = process.env.MD_EASY_TEST_PRINTER;
  test.skip(!printer, "Set MD_EASY_TEST_PRINTER to a disposable virtual printer for native spool verification.");
  const file = path.join(directory, "printer.md");
  await writeFile(file, "# Printed by Electron\n\nNative printer submission.\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Printed by Electron");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.getByLabel("Printer", { exact: true }).selectOption(printer!);
  await page.locator(".print-ws-footer").getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeHidden({ timeout: 30_000 });
});

test("the preload rejects unknown commands", async () => {
  await launch();
  const result = await page.evaluate(async () => {
    // The runtime must reject malformed input even when callers bypass TypeScript.
    const invoke = window.mdEasy!.invoke as (command: string) => Promise<unknown>;
    try { await invoke("unknown-command"); return "accepted"; }
    catch (error) { return String(error); }
  });
  expect(result).not.toBe("accepted");
});

test("a crashed renderer does not trap native window close", async () => {
  const file = path.join(directory, "crash.md");
  await writeFile(file, "# Crash lifecycle\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Crash lifecycle");
  await page.evaluate(async () => {
    window.mdEasy!.listen("close-requested", () => {});
    await window.mdEasy!.invoke("settings_path");
  });

  const crashed = await app!.evaluate(async ({ app, BrowserWindow }) => {
    // Keep the process alive after the window closes, as macOS normally does.
    app.removeAllListeners("window-all-closed");
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    await new Promise<void>((resolve) => {
      contents.once("render-process-gone", () => resolve());
      contents.forcefullyCrashRenderer();
    });
    const crashed = contents.isCrashed();
    BrowserWindow.getAllWindows()[0]!.close();
    return crashed;
  });

  expect(crashed).toBe(true);
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
});

test("file requests during reload reach the replacement renderer", async () => {
  const original = path.join(directory, "before-reload.md");
  const first = path.join(directory, "queued-first.md");
  const second = path.join(directory, "queued-second.md");
  await writeFile(original, "# Before reload\n");
  await writeFile(first, "# First queued file\n");
  await writeFile(second, "# Second queued file\n");
  await launch(original);
  await expect(page.locator(heading)).toHaveText("Before reload");
  await page.evaluate(async () => {
    window.mdEasy!.listen("open-file-requested", () => {});
    await window.mdEasy!.invoke("settings_path");
  });

  const reloaded = page.waitForEvent("domcontentloaded");
  await app!.evaluate(({ app, BrowserWindow }, paths) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.once("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      for (const filePath of paths) app.emit("open-file", { preventDefault: () => {} }, filePath);
    });
    contents.reload();
  }, [first, second]);
  await reloaded;

  await expect(page.getByRole("tab", { name: "queued-first.md", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "queued-second.md", exact: true })).toBeVisible();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror h1")).toHaveText("Second queued file");
});

test("same-document navigation preserves the unsaved close confirmation", async () => {
  const file = path.join(directory, "same-document.md");
  await writeFile(file, "# Same document\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Same document");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const raw = page.locator(".editor-pane-raw .cm-content");
  await raw.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nUnsaved edits.\n");
  await expect(raw).toContainText("Unsaved edits.");
  await page.evaluate(() => { window.location.hash = "same-document"; });

  await app!.evaluate(({ BrowserWindow, dialog }) => new Promise<void>((resolve) => {
    dialog.showMessageBox = async () => {
      resolve();
      return { response: 0, checkboxChecked: false };
    };
    BrowserWindow.getAllWindows()[0]!.close();
  }));

  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await expect(raw).toContainText("Unsaved edits.");
});

