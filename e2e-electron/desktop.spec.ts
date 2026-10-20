import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { WebPreferences } from "electron";
import type {} from "../src/ipc/bridge";

const projectRoot = path.resolve(import.meta.dirname, "..");
const heading = ".milkdown .ProseMirror h1";
/** A synthetic one-pixel PNG, to exercise the local image protocol. */
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
/** MD_EASY_CPU_THROTTLING_RATE, such as 4, runs every test with the
 *  renderer's CPU that many times slower, as on a slower machine. */
const cpuThrottlingRate = Number(process.env.MD_EASY_CPU_THROTTLING_RATE) || undefined;
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
  if (cpuThrottlingRate) await throttleCpu(cpuThrottlingRate);
}

/** Make the renderer's CPU `rate` times slower, as on a slower machine. */
async function throttleCpu(rate: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
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

/** Make the next Save As dialog wait until the returned function is called,
 *  then choose `file`, as a user who takes a while to pick a folder. The
 *  dialog sets `saveAsked` once it opens. */
async function holdSaveDialog(file: string): Promise<() => Promise<void>> {
  await app!.evaluate(({ dialog }, selectedFile) => {
    const answer = new Promise((resolve) => Reflect.set(globalThis, "answerSave", resolve));
    dialog.showSaveDialog = async () => {
      Reflect.set(globalThis, "saveAsked", true);
      await answer;
      return { canceled: false, filePath: selectedFile };
    };
  }, file);
  return () => app!.evaluate(() => (Reflect.get(globalThis, "answerSave") as () => void)());
}

/** The clipboard's text with line endings as "\n". Windows puts "\r\n" there. */
async function clipboardText(): Promise<string> {
  const text = await app!.evaluate(({ clipboard }) => clipboard.readText());
  return text.replace(/\r\n/g, "\n");
}

test("launching a Markdown file renders formatting and relative images in an isolated renderer", async () => {
  const file = path.join(directory, "launch.md");
  await writeFile(path.join(directory, "image.png"), onePixelPng);
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
    // The welcome document stays shown until the opened file's pane is ready, and
    // it has code blocks too, so wait for the file before looking for its block.
    await expect(pane.locator(".ProseMirror h1").first()).toHaveText("Policy");
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

test("opening a file with local images makes no failed loads", async () => {
  const file = path.join(directory, "images.md");
  await writeFile(path.join(directory, "image.png"), onePixelPng);
  await writeFile(file, "# Images\n\n![Block](image.png)\n\n![Missing](missing.png)\n\nInline ![inline](image.png) and ![gone](gone.png).\n");
  await launch();
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await chooseOpen(file);
  await expect(page.locator(".milkdown-image-block.md-image-missing")).toHaveAttribute("data-md-path", "missing.png");
  const loaded = () => page.locator(".ProseMirror img").evaluateAll((images) => images.filter((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0).length);
  await expect.poll(loaded).toBe(2);
  // Each image starts at its own URL, never at its path next to md-easy's page.
  expect(errors).toEqual([]);
});

test("a missing inline image shows its path in a chip, which a click locates", async () => {
  const file = path.join(directory, "inline.md");
  const markdown = "# Inline\n\nThe chart ![Chart](charts/missing.png) and ![Pixel](image.png) in a line.\n\n![Gone](missing.png)\n";
  await writeFile(path.join(directory, "image.png"), onePixelPng);
  await writeFile(path.join(directory, "found.png"), onePixelPng);
  await writeFile(file, markdown);
  await launch(file);
  const chip = page.locator(".milkdown-image-inline.md-image-missing");
  await expect(chip).toHaveAttribute("data-md-path", "charts/missing.png");
  await expect(chip).toHaveAttribute("title", "Missing image. Click to locate it.");
  await expect(chip).toBeVisible();
  await expect(chip.locator("img")).toBeHidden();
  // The working inline image and the missing image block are as they were.
  const loaded = (name: string) => page.getByRole("img", { name, exact: true }).evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0);
  await expect.poll(() => loaded("Pixel")).toBe(true);
  await expect(page.locator(".milkdown-image-inline.md-image-missing")).toHaveCount(1);
  await expect(page.locator(".milkdown-image-block.md-image-missing")).toHaveAttribute("data-md-path", "missing.png");
  await expect(page).toHaveTitle("inline.md — md-easy");

  const found = path.join(directory, "found.png");
  await app!.evaluate(({ dialog }, selectedFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
  }, found);
  await chip.click();

  await expect(page.locator(".milkdown-image-inline.md-image-missing")).toHaveCount(0);
  await expect.poll(() => loaded("Chart")).toBe(true);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-content")).toContainText(`The chart ![Chart](${found}) and`);
  expect(await readFile(file, "utf8")).toBe(markdown);
});

test("Shift+click on a missing image chip extends the selection to it", async () => {
  const file = path.join(directory, "chip-shift.md");
  await writeFile(file, "Short line ![Logo](logo.png) here.\n");
  await launch(file);
  await app!.evaluate(({ dialog }) => {
    Object.assign(globalThis, { dialogs: 0 });
    dialog.showOpenDialog = async () => {
      Object.assign(globalThis, { dialogs: Reflect.get(globalThis, "dialogs") + 1 });
      return { canceled: true, filePaths: [] };
    };
  });
  const line = page.locator(".milkdown .ProseMirror > p").first();
  const chip = line.locator(".md-image-missing");
  await expect(chip).toBeVisible();
  await line.click({ position: { x: 1, y: 8 } });
  // The right half of the chip takes the selection past it.
  const box = (await chip.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.keyboard.up("Shift");
  await page.keyboard.type("X");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("X here.\n");
  expect(await app!.evaluate(() => Reflect.get(globalThis, "dialogs"))).toBe(0);
});

test("Ctrl or Cmd+click and double-click on either half of an inline image follow only the image's own link", async () => {
  const file = path.join(directory, "image-links.md");
  // An image wide enough to click either half of.
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(path.join(directory, "one.md"), "# One\n");
  await writeFile(path.join(directory, "two.md"), "# Two\n");
  await writeFile(file, [
    "A chip [![Logo](logo.png)](https://example.com/chip)[after](https://example.com/after).",
    "An image [![Bar](bar.svg)](https://example.com/bar)[next](https://example.com/next).",
    "No link ![Gone](gone.png)[later](https://example.com/later).",
    "A file [![Bar](bar.svg)](one.md)[two](two.md).",
    "Plain line.",
  ].join("\n\n") + "\n");
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const images = page.locator(".milkdown .ProseMirror .milkdown-image-inline");
  await expect(images.nth(0)).toHaveClass(/md-image-missing/);
  await expect(images.nth(2)).toHaveClass(/md-image-missing/);
  await expect.poll(() => images.nth(1).locator("img").evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth)).toBe(48);
  const plain = page.locator(".milkdown .ProseMirror > p").filter({ hasText: "Plain line." });
  const preview = page.locator(".milkdown-link-preview");
  /** Ctrl or Cmd+click `fraction` of the way across `target`, then click plain
   *  text and wait for the link preview to go, so it cannot cover the next
   *  target. Crepe shows or hides the preview only once the pointer has
   *  rested for 50 ms, so it can still be up after the click. It sits over
   *  the line above its link, and a click on it opens its own link. */
  const ctrlClick = async (target: Locator, fraction: number) => {
    const box = (await target.boundingBox())!;
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    await page.keyboard.up("ControlOrMeta");
    await plain.click({ position: { x: 2, y: 8 } });
    await expect(preview).toBeHidden();
  };
  // ProseMirror puts a click on an image's right half after the image, where
  // the next link starts.
  for (const index of [0, 1, 2]) {
    await ctrlClick(images.nth(index), 0.25);
    await ctrlClick(images.nth(index), 0.9);
  }
  // The text link opens last, so every link the image clicks opened is in by then.
  await ctrlClick(page.getByText("after", { exact: true }), 0.5);
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual([
    "https://example.com/chip",
    "https://example.com/chip",
    "https://example.com/bar",
    "https://example.com/bar",
    "https://example.com/after",
  ]);
  // A double-click on an image inside a link to a Markdown file opens that file.
  const box = (await images.nth(3).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(page).toHaveTitle("one.md — md-easy");
});

/** The point `fraction` of the way across the character at `index` of the
 *  first text node in the document view that reads `text`. A negative
 *  `index` counts from the end. */
function pointOn(text: string, index: number, fraction: number): Promise<{ x: number; y: number }> {
  return page.locator(".milkdown .ProseMirror").evaluate((element, [text, index, fraction]) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, (node) => (node.textContent === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP));
    const node = walker.nextNode()!;
    const start = index < 0 ? text.length + index : index;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const box = range.getBoundingClientRect();
    return { x: box.left + box.width * fraction, y: box.top + box.height / 2 };
  }, [text, index, fraction] as const);
}

/** Click `fraction` of the way across a character, as `pointOn` finds it,
 *  and have ProseMirror read the click's caret at once. ProseMirror reads it
 *  on the browser's selectionchange event, which can come after a key sent
 *  right after the click, so the key would act on the caret from before. */
async function clickOn(text: string, index: number, fraction: number): Promise<void> {
  const point = await pointOn(text, index, fraction);
  await page.mouse.click(point.x, point.y);
  await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
}

/** Select the first text node that reads `text` from its end with the
 *  keyboard, as a double-click on Windows would also select a space after
 *  it. ProseMirror reads a selection when the browser reports it, which can
 *  come after a key pressed right away, so this has it read it now. */
async function selectText(text: string): Promise<void> {
  await clickOn(text, -1, 0.75);
  for (let i = 0; i < text.length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
}

test("Ctrl or Cmd+click and double-click on either half of a character follow only that character's link", async () => {
  const file = path.join(directory, "text-links.md");
  await writeFile(path.join(directory, "two.md"), "# Two\n");
  await writeFile(file, [
    "A [link](https://example.com/link)s and more.",
    "Plain[next](https://example.com/next) text.",
    "[home](https://example.com/home)[second](https://example.com/second) links.",
    "Ends with [them](https://example.com/them)",
    "A file [two](two.md) here.",
    "Plain line.",
  ].join("\n\n") + "\n");
  // Without the URL after each link, the text after a link starts right at
  // its last character.
  await writeFile(path.join(directory, "profile", "settings.toml"), 'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nlinkDisplay = "text-only"\n');
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const editor = page.locator(".milkdown .ProseMirror");
  await expect(editor.locator("a")).toHaveCount(6);
  const plain = editor.locator("p").filter({ hasText: "Plain line." });
  const preview = page.locator(".milkdown-link-preview");
  /** Ctrl or Cmd+click `fraction` of the way across a character, then click
   *  plain text and wait for the link preview to go, so it cannot cover the
   *  next target, as in the inline image test above. */
  const ctrlClick = async (text: string, index: number, fraction: number) => {
    const point = await pointOn(text, index, fraction);
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
    await plain.click({ position: { x: 2, y: 8 } });
    await expect(preview).toBeHidden();
  };
  // ProseMirror puts a click on a character's right half after the character,
  // where the plain text or the link after it starts.
  await ctrlClick("link", -1, 0.75);
  await ctrlClick("s and more.", 0, 0.25);
  await ctrlClick("Plain", -1, 0.75);
  await ctrlClick("home", -1, 0.75);
  await ctrlClick("second", 0, 0.25);
  // A link that ends its paragraph opens on its last character's right half,
  // and not on a click right of it.
  await ctrlClick("them", -1, 1.5);
  await ctrlClick("them", -1, 0.75);
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual([
    "https://example.com/link",
    "https://example.com/home",
    "https://example.com/second",
    "https://example.com/them",
  ]);
  // A double-click on the right half of a link to a Markdown file opens that file.
  const point = await pointOn("two", -1, 0.75);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page).toHaveTitle("two.md — md-easy");
});

test("Ctrl or Cmd+click that opens no link leaves the caret where it lands", async () => {
  const file = path.join(directory, "ctrl-click-plain.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, [
    "Before the link [docs](https://example.com/docs) after the link.",
    "# Plain heading",
    "- outer item\n  - inner item with words\n  - another inner",
    "Text ![Bar](bar.svg) more words.",
  ].join("\n\n") + "\n");
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const image = page.locator(".milkdown .ProseMirror .milkdown-image-inline img");
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  const ctrlClick = async (point: { x: number; y: number }) => {
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
  };
  /** The selected text, and the element ProseMirror marks as selected as a
   *  node. Crepe's inline image marks itself with the class "selected"
   *  instead, which `selectedImage` finds. */
  const selection = () => page.evaluate(() => ({
    text: document.getSelection()!.toString(),
    node: document.querySelector(".ProseMirror .ProseMirror-selectednode")?.tagName ?? null,
  }));
  const selectedImage = page.locator(".milkdown .ProseMirror .milkdown-image-inline.selected");
  // ProseMirror selected the paragraph, heading or list item under the
  // pointer as a node, so the next key replaced all of it.
  await ctrlClick(await pointOn(" after the link.", 3, 0.25));
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("a");
  await ctrlClick(await pointOn("Plain heading", 2, 0.25));
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("b");
  // A second Ctrl or Cmd+click inside a selected node selected the node around it.
  await ctrlClick(await pointOn("inner item with words", 2, 0.25));
  await ctrlClick(await pointOn("inner item with words", 17, 0.25));
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("c");
  // On an image it selects the image, as a plain click does, also the
  // second time. Right after the selected image it puts the caret there,
  // where Chromium can report no change of the selection.
  const box = (await image.boundingBox())!;
  await ctrlClick({ x: box.x + box.width * 0.3, y: box.y + box.height / 2 });
  await expect(selectedImage).toHaveCount(1);
  await ctrlClick({ x: box.x + box.width * 0.7, y: box.y + box.height / 2 });
  await expect(selectedImage).toHaveCount(1);
  await expect.poll(selection).toEqual({ text: "", node: null });
  await ctrlClick(await pointOn(" more words.", 0, 0.3));
  await expect(selectedImage).toHaveCount(0);
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("d");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Before the link [docs](https://example.com/docs) afater the link.",
    "# Plbain heading",
    "- outer item\n  - inner item with wcords\n  - another inner",
    "Text ![Bar](bar.svg)d more words.",
  ].join("\n\n") + "\n");
  expect(await app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual([]);
});

test("Ctrl or Cmd+click inside a selection puts the caret where it lands", async () => {
  const file = path.join(directory, "ctrl-click-selection.md");
  await writeFile(file, [
    "Selected words here.",
    "First paragraph with plain words.",
    "Second paragraph with more words.",
    "B [six](https://example.com/6) and then more.",
    "Last paragraph here.",
  ].join("\n\n") + "\n");
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  await expect(page.locator(".milkdown .ProseMirror .md-link-url")).toHaveCount(1);
  const ctrlClick = async (point: { x: number; y: number }) => {
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
  };
  /** The selected text, and the element ProseMirror selected as a node. */
  const selection = () => page.evaluate(() => ({
    text: document.getSelection()!.toString(),
    node: document.querySelector(".ProseMirror .ProseMirror-selectednode")?.tagName ?? null,
  }));
  // Chromium keeps a selection that a press lands inside, and puts the caret
  // there on the release, which ProseMirror cancelled, so the next key
  // replaced the whole selection.
  await selectText("Selected words here.");
  await expect.poll(selection).toEqual({ text: "Selected words here.", node: null });
  await ctrlClick(await pointOn("Selected words here.", 3, 0.25));
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("a");
  // A paragraph the block handle selected.
  const block = page.locator(".milkdown .ProseMirror > p").filter({ hasText: "First paragraph" });
  const blockBox = (await block.boundingBox())!;
  await page.mouse.move(blockBox.x + 10, blockBox.y + blockBox.height / 2);
  const grip = page.locator(".milkdown-block-handle .operation-item").last();
  await expect.poll(async () => {
    const box = await grip.boundingBox();
    return !!box && box.y < blockBox.y + blockBox.height && box.y + box.height > blockBox.y;
  }).toBe(true);
  const gripBox = (await grip.boundingBox())!;
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await selection()).node).toBe("P");
  await ctrlClick(await pointOn("First paragraph with plain words.", 6, 0.25));
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("b");
  // The whole document, with Ctrl or Cmd still held from Ctrl or Cmd+A.
  const point = await pointOn("Second paragraph with more words.", 7, 0.25);
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.press("a");
  await expect.poll(async () => (await selection()).text).toContain("Last paragraph here.");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("ControlOrMeta");
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("c");
  // Ctrl or Cmd+click on the URL after a link opens the link and puts the
  // caret at the link's end, also inside a selection.
  await clickOn("B ", 0, 0.25);
  await page.keyboard.down("Shift");
  await clickOn(" and then more.", 10, 0.25);
  await page.keyboard.up("Shift");
  await expect.poll(selection).toEqual({ text: "B six and then ", node: null });
  const url = (await page.locator(".milkdown .ProseMirror .md-link-url").boundingBox())!;
  await ctrlClick({ x: url.x + url.width / 2, y: url.y + url.height / 2 });
  await expect.poll(selection).toEqual({ text: "", node: null });
  await page.keyboard.type("d");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Selaected words here.",
    "First bparagraph with plain words.",
    "Second cparagraph with more words.",
    "B [six](https://example.com/6)d and then more.",
    "Last paragraph here.",
  ].join("\n\n") + "\n");
  expect(await app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual(["https://example.com/6"]);
});

test("Ctrl or Cmd+click on an image puts the caret beside it when it opens a link, and selects it from a code block", async () => {
  const file = path.join(directory, "ctrl-click-image.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, [
    "```\nconst alpha = 1;\n```",
    "Text with some words tail.",
    "Pics ![Bar](bar.svg) after.",
    "Filler line.",
    "Go [![Bar](bar.svg)](https://example.com/img) end.",
  ].join("\n\n") + "\n");
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const images = page.locator(".milkdown .ProseMirror .milkdown-image-inline");
  for (const index of [0, 1]) {
    await expect.poll(() => images.nth(index).locator("img").evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  }
  const preview = page.locator(".milkdown-link-preview");
  /** Press Ctrl or Cmd `fraction` of the way across `image` and hold the
   *  button for `hold` ms, then move the pointer off the link and wait for
   *  its preview to go, so the preview cannot cover the next target. */
  const ctrlClick = async (image: Locator, fraction: number, hold = 0) => {
    const box = (await image.boundingBox())!;
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
    await page.mouse.down();
    if (hold) await page.waitForTimeout(hold);
    await page.mouse.up();
    await page.keyboard.up("ControlOrMeta");
    const away = (await page.locator(".milkdown .ProseMirror > p").first().boundingBox())!;
    await page.mouse.move(away.x + 2, away.y + away.height / 2);
    await expect(preview).toBeHidden();
  };
  // Chromium puts no caret on an image, so a Ctrl or Cmd+click that opened
  // the image's link left a selected image or text elsewhere selected, and
  // the next key replaced it.
  await ctrlClick(images.first(), 0.5);
  await expect(images.first()).toHaveClass(/selected/);
  await ctrlClick(images.last(), 0.25);
  await page.keyboard.type("v");
  await selectText("Text with some words tail.");
  await ctrlClick(images.last(), 0.75);
  await page.keyboard.type("w");
  // With focus in a code block, ProseMirror's selection stays in the block.
  // Focusing the document before selecting the image put the browser's
  // selection, and focus, back there, so the image showed as selected and
  // the next key went into the block. A press of a usual length shows it.
  // An instant one ends before ProseMirror moves the browser's selection.
  await page.locator(".milkdown .ProseMirror .cm-line").click();
  await ctrlClick(images.first(), 0.5, 150);
  await page.keyboard.type("z");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "```\nconst alpha = 1;\n```",
    "Text with some words tail.",
    "Pics z after.",
    "Filler line.",
    "Go v[![Bar](bar.svg)](https://example.com/img)w end.",
  ].join("\n\n") + "\n");
  expect(await app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual(["https://example.com/img", "https://example.com/img"]);
});

test("Ctrl or Cmd+click in a code block adds a cursor only once the block has focus", async () => {
  const file = path.join(directory, "ctrl-click-code.md");
  await writeFile(file, ["Intro line here.", "```\nconst code = 1;\nlet other = 2;\n```", "Outro line."].join("\n\n") + "\n");
  await launch(file);
  const block = page.locator(".milkdown .ProseMirror .milkdown-code-block");
  await expect(block.locator(".cm-line")).toHaveCount(2);
  const ctrlClick = async (point: { x: number; y: number }) => {
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
  };
  await clickOn("Intro line here.", 3, 0.25);
  // CodeMirror added a cursor to the one at the block's start, which the user
  // had not put there, so typing went in at both.
  await ctrlClick(await pointOn("let other = 2;", 6, 0.25));
  await expect(block.locator(".cm-cursor")).toHaveCount(1);
  await page.keyboard.type("q");
  // In the block that has focus, it still adds a cursor.
  await ctrlClick(await pointOn("const code = 1;", 6, 0.25));
  await expect(block.locator(".cm-cursor")).toHaveCount(2);
  await page.keyboard.type("w");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["Intro line here.", "```\nconst wcode = 1;\nlet otqwher = 2;\n```", "Outro line."].join("\n\n") + "\n");
});

test("Shift+click or Shift+drag on a link's text extends the selection", async () => {
  const file = path.join(directory, "shift-click-link.md");
  await writeFile(file, [
    "Before the link [docs](https://example.com/docs) after the link.",
    "Start [alpha](https://example.com/a) middle [beta](https://example.com/b) end.",
    "From here [gamma](https://example.com/c) to there.",
    "| Head A | Head B |\n| --- | --- |\n| one [delta](https://example.com/d) x | two |\n| three | four |",
  ].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(5);
  const shiftClick = async (point: { x: number; y: number }) => {
    await page.keyboard.down("Shift");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Shift");
  };
  const selected = () => page.evaluate(() => document.getSelection()!.toString());
  // Chromium put the caret at a Shift+click on a link, so typing went in
  // there instead of over the text from the caret to the click.
  await clickOn("docs", -1, 0.75);
  await shiftClick(await pointOn("docs", 0, 0.25));
  await expect.poll(selected).toBe("docs");
  await page.keyboard.type("a");
  await clickOn("Start ", 2, 0.25);
  await shiftClick(await pointOn("beta", 2, 0.25));
  await expect.poll(selected).toBe("art alpha middle be");
  await page.keyboard.type("b");
  // A Shift+drag that starts on a link extends the selection from the caret
  // too. Chromium started a new selection at the press.
  await clickOn("From here ", 2, 0.25);
  const press = await pointOn("gamma", 2, 0.25);
  const release = await pointOn(" to there.", 5, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(selected).toBe("om here gamma to t");
  await page.keyboard.type("c");
  // Shift+click from a link onto other text, and inside a table cell.
  await clickOn("delta", 1, 0.25);
  await shiftClick(await pointOn(" x", 1, 0.75));
  await expect.poll(selected).toBe("elta x");
  await clickOn("one ", 1, 0.25);
  await shiftClick(await pointOn("delta", 2, 0.25));
  await expect.poll(selected).toBe("ne de");
  await page.keyboard.type("d");
  // Shift+click into another cell still selects the cells.
  await clickOn("two", 1, 0.5);
  await shiftClick(await pointOn("lta", 1, 0.5));
  await expect(page.locator(".milkdown .ProseMirror .selectedCell")).toHaveCount(2);
  await clickOn("four", 1, 0.5);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Before the link [a](https://example.com/docs) after the link.",
    "Stb[ta](https://example.com/b) end.",
    "Frchere.",
    // Milkdown pads the columns of a table it writes.
    [
      "| Head A                           | Head B |",
      "| -------------------------------- | ------ |",
      "| od[lta](https://example.com/d) x | two    |",
      "| three                            | four   |",
    ].join("\n"),
  ].join("\n\n") + "\n");
});

test("Shift+click on an image in a line extends the selection to the side of it clicked, and a Shift+drag from there follows the pointer", async () => {
  const file = path.join(directory, "shift-click-image.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, [
    "Pics ![Bar](bar.svg) after.",
    "Go [![Bar](bar.svg) text](https://example.com/m) end.",
    "Drag ![Bar](bar.svg) from the image here.",
  ].join("\n\n") + "\n");
  await launch(file);
  const images = page.locator(".milkdown .ProseMirror .milkdown-image-inline img");
  await expect(images).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await expect.poll(() => images.nth(index).evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  }
  /** The image in the paragraph that starts with `text`. */
  const imageIn = (text: string) => page.locator(".milkdown .ProseMirror > p").filter({ hasText: text }).locator(".milkdown-image-inline img");
  /** Shift+click `fraction` of the way across `image`. */
  const shiftClick = async (image: Locator, fraction: number) => {
    const box = (await image.boundingBox())!;
    await page.keyboard.down("Shift");
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    await page.keyboard.up("Shift");
  };
  // Chromium does not extend the selection on a Shift+click on an image, so
  // the caret stayed where it was and the next key went in there.
  await clickOn(" after.", 2, 0.25);
  await shiftClick(imageIn("Pics"), 0.25);
  await expect.poll(() => page.evaluate(() => document.getSelection()!.toString())).toBe(" a");
  await page.keyboard.type("x");
  // On the right half of an image inside a link, the selection ends after it.
  await clickOn(" end.", 2, 0.25);
  await shiftClick(imageIn("Go"), 0.75);
  await expect.poll(() => page.evaluate(() => document.getSelection()!.toString())).toBe(" text e");
  await page.keyboard.type("y");
  // A Shift+drag from an image follows the pointer. It stopped at the side
  // of the image pressed.
  await clickOn("Drag ", 1, 0.75);
  const box = (await imageIn("Drag").boundingBox())!;
  const release = await pointOn(" from the image here.", 8, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => page.evaluate(() => document.getSelection()!.toString())).toBe("ag  from th");
  await page.keyboard.type("z");
  await page.keyboard.press("ControlOrMeta+s");
  // Typing over selected text of a link keeps the link.
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Pics xfter.",
    "Go [![Bar](bar.svg)y](https://example.com/m)nd.",
    "Drze image here.",
  ].join("\n\n") + "\n");
});

test("Shift+click in the document while a code block or the Markdown pane has focus puts the caret at the click", async () => {
  const file = path.join(directory, "shift-click-from-code.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, [
    "```js\nconst alpha = 1;\nconst beta = 2;\n```",
    "Plain words here.",
    "Then [docs](https://example.com/docs) after the link.",
    "Pics ![Bar](bar.svg) after.",
    "Go [![Bar](bar.svg) text](https://example.com/m) end.",
    "Last line.",
  ].join("\n\n") + "\n");
  await launch(file);
  const lines = page.locator(".milkdown .ProseMirror .cm-line");
  await expect(lines).toHaveCount(2);
  const images = page.locator(".milkdown .ProseMirror .milkdown-image-inline img");
  await expect(images).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect.poll(() => images.nth(index).evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  }
  /** Put the caret at the start of the code block, Shift+click `point` and
   *  type `typed`. */
  const fromCode = async (point: { x: number; y: number }, typed: string) => {
    const line = (await lines.first().boundingBox())!;
    await page.mouse.click(line.x + 1, line.y + line.height / 2);
    await expect(page.locator(".milkdown .ProseMirror .cm-content")).toBeFocused();
    await page.keyboard.down("Shift");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Shift");
    await page.keyboard.type(typed);
  };
  /** The point `fraction` of the way across `image`. */
  const across = async (image: Locator, fraction: number) => {
    const box = (await image.boundingBox())!;
    return { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
  };
  // Chromium extended the code block's selection toward the click, which
  // CodeMirror cut off at the end of the block, and focus stayed in the
  // block. The next key replaced the code from the caret on.
  await fromCode(await pointOn("Plain words here.", 3, 0.25), "p");
  // So did a Shift+click on the URL shown after a link.
  const url = (await page.locator(".milkdown .ProseMirror .md-link-url").first().boundingBox())!;
  await fromCode({ x: url.x + url.width / 2, y: url.y + url.height / 2 }, "u");
  await fromCode(await pointOn("docs", 2, 0.25), "z");
  // Chromium puts no caret on an image, so the next key went into the block.
  await fromCode(await across(images.first(), 0.75), "x");
  await fromCode(await across(images.last(), 0.25), "y");
  // With the caret in the split's Markdown pane, Chromium selected that
  // pane's text from its start, and the next key replaced it.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await page.locator(".editor-pane-raw .cm-line").filter({ hasText: "Last line." }).click();
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  const last = await pointOn("Last line.", 4, 0.25);
  await page.mouse.click(last.x, last.y);
  await page.keyboard.up("Shift");
  await page.keyboard.type("m");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "```js\nconst alpha = 1;\nconst beta = 2;\n```",
    "Plapin words here.",
    "Then [dozcs](https://example.com/docs)u after the link.",
    "Pics ![Bar](bar.svg)x after.",
    "Go y[![Bar](bar.svg) text](https://example.com/m) end.",
    "Lastm line.",
  ].join("\n\n") + "\n");
});

test("Shift+click in the document from the find card or the Markdown pane puts the caret at the click after a caret or cell selection in a table", async () => {
  const file = path.join(directory, "shift-click-from-table.md");
  await writeFile(file, [
    "| Head A | Head B |\n| --- | --- |\n| alpha text | beta text |\n| gamma text | delta text |\n| epsilon | zeta |",
    "First line.",
    "Last line.",
  ].join("\n\n") + "\n");
  await launch(file);
  const documentView = page.locator(".milkdown .ProseMirror");
  const selectedCells = documentView.locator(".selectedCell");
  const find = page.getByRole("textbox", { name: "Find in document" });
  /** Shift+click a quarter of the way across the character at `index` of
   *  the text node that reads `text`. */
  const shiftClick = async (text: string, index: number) => {
    const point = await pointOn(text, index, 0.25);
    await page.keyboard.down("Shift");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Shift");
  };
  /** Select the cells from the one that reads `from` to the one that reads
   *  `to` with a Shift+click while the document has focus. */
  const selectCells = async (from: string, to: string) => {
    await clickOn(from, 1, 0.5);
    await shiftClick(to, 1);
    await expect(selectedCells).toHaveCount(2);
  };
  /** Leave the document for the find card. */
  const toFind = async () => {
    await page.keyboard.press("ControlOrMeta+f");
    await expect(find).toBeFocused();
  };
  // prosemirror-tables took the Shift+click with the document's selection
  // from before, a caret in another cell, and selected both cells. Focus
  // stayed in the find card, so the next key went in there.
  await clickOn("alpha text", 2, 0.25);
  await toFind();
  await shiftClick("beta text", 2);
  await expect(documentView).toBeFocused();
  await expect(selectedCells).toHaveCount(0);
  await page.keyboard.type("Q");
  // With a cell selection from before, it took a Shift+click anywhere in the
  // document and selected the cell where that selection started.
  await selectCells("gamma text", "delta text");
  await toFind();
  await shiftClick("First line.", 6);
  await expect(documentView).toBeFocused();
  await expect(selectedCells).toHaveCount(0);
  await page.keyboard.type("R");
  await toFind();
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  // So did a Shift+click from the split's Markdown pane, and the next key
  // went into the Markdown at its caret.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const markdown = page.locator(".editor-pane-raw .cm-content");
  /** Leave the document for the end of the Markdown pane's last line of text. */
  const toMarkdown = async () => {
    await page.locator(".editor-pane-raw .cm-line").filter({ hasText: /^Last/ }).click();
    await page.keyboard.press("End");
    await expect(markdown).toBeFocused();
  };
  await clickOn("epsilon", 2, 0.25);
  await toMarkdown();
  await shiftClick("zeta", 2);
  await expect(documentView).toBeFocused();
  await expect(selectedCells).toHaveCount(0);
  await page.keyboard.type("S");
  await selectCells("alpha text", "gamma text");
  await toMarkdown();
  await shiftClick("Last line.", 4);
  await expect(documentView).toBeFocused();
  await expect(selectedCells).toHaveCount(0);
  await page.keyboard.type("T");
  // A Shift+drag from there across cells still selects the cells, as a
  // plain drag does.
  await toMarkdown();
  const press = await pointOn("beQta text", 2, 0.25);
  const release = await pointOn("delta text", 2, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(documentView).toBeFocused();
  await expect(selectedCells).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+s");
  // Milkdown pads the columns of a table it writes.
  await expect.poll(() => readFile(file, "utf8")).toBe([
    [
      "| Head A     | Head B     |",
      "| ---------- | ---------- |",
      "| alpha text | beQta text |",
      "| gamma text | delta text |",
      "| epsilon    | zeSta      |",
    ].join("\n"),
    "First Rline.",
    "LastT line.",
  ].join("\n\n") + "\n");
});

test("Shift+click from the find card or the Markdown pane beside or below a table cell's text puts the caret where a plain click does", async () => {
  const file = path.join(directory, "shift-click-cell-space.md");
  // The note wraps, so its row is taller than the line of "epsilon".
  const note = "a note long enough to wrap onto more than one line in its cell, both in the Document view and in the document pane of the split view, whose cells are narrower still";
  await writeFile(file, [
    `| Head A | Head B |\n| --- | --- |\n| alpha | beta |\n| gamma | delta |\n| epsilon | ${note} |\n| eta | zeta |`,
    "First line.",
    "Last line.",
  ].join("\n\n") + "\n");
  await launch(file);
  const documentView = page.locator(".milkdown .ProseMirror");
  const selectedCells = documentView.locator(".selectedCell");
  const find = page.getByRole("textbox", { name: "Find in document" });
  /** Shift+click the cell that reads `text`, `inset` pixels from its left
   *  edge, or from its right edge when negative, and `y` of the way down,
   *  then type `typed`. Within 8 pixels of a cell's edge, Crepe shows the
   *  button that adds a row or column under the pointer, so the presses stay
   *  11 pixels in, which is still in the cell's 16-pixel padding. */
  const shiftClickCell = async (text: string, inset: number, y: number, typed: string) => {
    const box = (await documentView.locator("td, th").filter({ hasText: new RegExp(`^${text}$`) }).boundingBox())!;
    await page.keyboard.down("Shift");
    await page.mouse.click(inset >= 0 ? box.x + inset : box.x + box.width + inset, box.y + box.height * y);
    await page.keyboard.up("Shift");
    await expect(documentView).toBeFocused();
    await expect(selectedCells).toHaveCount(0);
    await page.keyboard.type(typed);
  };
  /** Leave the document for the find card. */
  const toFind = async () => {
    await page.keyboard.press("ControlOrMeta+f");
    await expect(find).toBeFocused();
  };
  // A press right of or below a cell's text gave the position after the
  // cell's paragraph. The caret went to the start of the next cell, so
  // prosemirror-tables selected the cells from there to the one pressed, and
  // the next key replaced their text. For the last column that took the
  // cells up to the start of the next row.
  await clickOn("First line.", 2, 0.25);
  await toFind();
  await shiftClickCell("gamma", -11, 0.5, "A");
  await toFind();
  await shiftClickCell("delta", -11, 0.5, "B");
  await toFind();
  await shiftClickCell("epsilon", -11, 0.6, "C");
  // After the table's last cell the caret went past the table, and Chromium
  // extended the selection from there back to the click, over the cell's text.
  await toFind();
  await shiftClickCell("zeta", -11, 0.5, "D");
  await toFind();
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const markdown = page.locator(".editor-pane-raw .cm-content");
  /** Leave the document for the end of the Markdown pane's last line of text. */
  const toMarkdown = async () => {
    await page.locator(".editor-pane-raw .cm-line").filter({ hasText: /^Last/ }).click();
    await page.keyboard.press("End");
    await expect(markdown).toBeFocused();
  };
  await toMarkdown();
  await shiftClickCell("Head B", -11, 0.5, "E");
  // A plain click left of a cell's text, below its last line, puts the caret
  // at the end of that line. The caret went before the cell's paragraph, at
  // the start of the line, so the next key replaced the cell's text. On
  // Windows, Chromium puts the caret of such a click at the point of the line
  // nearest to it instead, here its start.
  await toMarkdown();
  await shiftClickCell("epsilonC", 11, 0.6, "F");
  const epsilon = process.platform === "win32" ? "FepsilonC" : "epsilonCF";
  await page.keyboard.press("ControlOrMeta+s");
  // Milkdown pads the columns of a table it writes, here to the note's width.
  const second = (text: string) => text.padEnd(note.length);
  await expect.poll(() => readFile(file, "utf8")).toBe([
    [
      `| Head A    | ${second("Head BE")} |`,
      `| --------- | ${"-".repeat(note.length)} |`,
      `| alpha     | ${second("beta")} |`,
      `| gammaA    | ${second("deltaB")} |`,
      `| ${epsilon} | ${note} |`,
      `| eta       | ${second("zetaD")} |`,
    ].join("\n"),
    "First line.",
    "Last line.",
  ].join("\n\n") + "\n");
});

/** Shift+click `point`. */
async function shiftClickAt(point: { x: number; y: number }): Promise<void> {
  await page.keyboard.down("Shift");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Shift");
}

/** Put the caret at the end of the split's Markdown pane's line that reads
 *  `text`. */
async function caretInMarkdown(text: string): Promise<void> {
  await page.locator(".editor-pane-raw .cm-line").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).click();
  await page.keyboard.press("End");
  await expect(page.locator(".editor-pane-raw .cm-content")).toBeFocused();
}

test("Shift+click from the find card, the Markdown pane or a code block on a code block's toolbar, edge or preview is a plain click there", async () => {
  const file = path.join(directory, "shift-click-code-tools.md");
  await writeFile(file, ["```\nconst alpha = 1;\n```", "```\nconst beta = 2;\n```", "```mermaid\ngraph TD; A-->B;\n```", "Last line."].join("\n\n") + "\n");
  await launch(file);
  const blocks = page.locator(".milkdown .ProseMirror .milkdown-code-block");
  await expect(blocks.nth(2).locator(".preview svg")).toBeVisible();
  const find = page.getByRole("textbox", { name: "Find in document" });
  /** The middle of `block`'s toolbar, between its language and Copy buttons. */
  const toolbar = async (block: Locator) => {
    const language = (await block.locator(".language-button").boundingBox())!;
    const copy = (await block.locator(".copy-button").boundingBox())!;
    return { x: (language.x + language.width + copy.x) / 2, y: language.y + language.height / 2 };
  };
  // A plain click on a code block's toolbar, edge or preview puts the cursor
  // at the end of its code. From the find card, Chromium focused the document
  // at its old caret instead, at the end of the last line.
  await clickOn("Last line.", -1, 0.75);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await shiftClickAt(await toolbar(blocks.nth(0)));
  await expect(blocks.nth(0).locator(".cm-content")).toBeFocused();
  await page.keyboard.type("a");
  // From the split's Markdown pane, Chromium extended the pane's selection
  // to its start, and the next key replaced the Markdown before the caret.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await caretInMarkdown("Last line.");
  const edge = (await blocks.nth(1).boundingBox())!;
  await shiftClickAt({ x: edge.x + edge.width / 2, y: edge.y + edge.height - 3 });
  await expect(blocks.nth(1).locator(".cm-content")).toBeFocused();
  await page.keyboard.type("b");
  // From another code block, Chromium selected that block's code from its
  // cursor to the end, and the next key replaced the code.
  const line = (await blocks.nth(0).locator(".cm-line").boundingBox())!;
  await page.mouse.click(line.x + 1, line.y + line.height / 2);
  await expect(blocks.nth(0).locator(".cm-content")).toBeFocused();
  await shiftClickAt(await centerOf(blocks.nth(2).locator(".preview")));
  await expect(blocks.nth(2).locator(".cm-content")).toBeFocused();
  await page.keyboard.type("c");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["```\nconst alpha = 1;a\n```", "```\nconst beta = 2;b\n```", "```mermaid\ngraph TD; A-->B;c\n```", "Last line."].join("\n\n") + "\n");
});

test("a click or Shift+click on a list item's bullet puts the caret at the start of its text, also from the find card, the Markdown pane or a code block", async () => {
  const file = path.join(directory, "bullet-clicks.md");
  await writeFile(file, ["```\nconst alpha = 1;\n```", "- one\n- two\n- three\n- four\n- five", "| A | B |\n| --- | --- |\n| x1 | y1 |", "Last line."].join("\n\n") + "\n");
  await launch(file);
  const documentView = page.locator(".milkdown .ProseMirror");
  const selectedCells = documentView.locator(".selectedCell");
  const find = page.getByRole("textbox", { name: "Find in document" });
  /** The middle of the bullet of the list item whose text starts with `text`. */
  const bullet = (text: string) => centerOf(documentView.locator(".milkdown-list-item-block", { has: page.locator("p", { hasText: new RegExp(`^${text}`) }) }).locator(".label-wrapper"));
  /** Click the bullet of the item that starts with `text`, and type `typed`. */
  const clickBullet = async (text: string, shift: boolean, typed: string) => {
    const point = await bullet(text);
    if (shift) await shiftClickAt(point);
    else await page.mouse.click(point.x, point.y);
    await expect(documentView).toBeFocused();
    await page.keyboard.type(typed);
  };
  // A bullet is a drawing with no place for a caret, so Chromium put the
  // caret of a plain click there at the start of the document.
  await clickOn("Last line.", -1, 0.75);
  await clickBullet("one", false, "A");
  // From the find card, a Shift+click focused the document without a caret,
  // and the next key was lost.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await clickBullet("two", true, "B");
  // With cells selected, prosemirror-tables took the Shift+click, kept a cell
  // selected and focus in the find card, where the next key went.
  await clickOn("x1", 1, 0.5);
  await shiftClickAt(await pointOn("y1", 1, 0.5));
  await expect(selectedCells).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  const findText = await find.inputValue();
  await clickBullet("three", true, "C");
  await expect(selectedCells).toHaveCount(0);
  await expect(find).toHaveValue(findText);
  // From the split's Markdown pane, a plain click put the caret at the start
  // of the document too, and a Shift+click put none.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await caretInMarkdown("Last line.");
  await clickBullet("four", false, "D");
  await caretInMarkdown("Last line.");
  await clickBullet("five", true, "E");
  // From a code block, focus stayed in the block, which a Shift+click
  // selected to its end, so the next key replaced the code.
  const line = (await documentView.locator(".cm-line").boundingBox())!;
  await page.mouse.click(line.x + 1, line.y + line.height / 2);
  await expect(documentView.locator(".cm-content")).toBeFocused();
  await clickBullet("Aone", true, "F");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["```\nconst alpha = 1;\n```", "- FAone\n- Btwo\n- Cthree\n- Dfour\n- Efive", "| A | B |\n| --- | --- |\n| x1 | y1 |", "Last line."].join("\n\n") + "\n");
});

test("Shift+click from the find card or the Markdown pane on a rule or an image on its own line selects it as a click does, and so does a click from a code block", async () => {
  const file = path.join(directory, "shift-click-rule-image.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, ["```\nconst alpha = 1;\n```", "Above.", "---", "![Bar](bar.svg)", "Middle.", "---", "![Bar](bar.svg)", "Last line."].join("\n\n") + "\n");
  await launch(file);
  const documentView = page.locator(".milkdown .ProseMirror");
  const rules = documentView.locator("hr");
  const images = documentView.locator(".milkdown-image-block");
  await expect(images).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect.poll(() => images.nth(index).locator("img").evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  }
  const find = page.getByRole("textbox", { name: "Find in document" });
  // From the find card, a Shift+click on a rule or an image focused the
  // document and left its selection as it was, so the next key went to its
  // old caret or was lost. A click selects the rule or the image.
  await clickOn("Last line.", -1, 0.75);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await shiftClickAt(await centerOf(rules.first()));
  await expect(documentView).toBeFocused();
  await expect(rules.first()).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.type("a");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await shiftClickAt(await centerOf(images.first().locator("img")));
  await expect(documentView).toBeFocused();
  await expect(images.first()).toHaveClass(/selected/);
  await page.keyboard.type("b");
  // From a code block, ProseMirror selected the image, but focus went back
  // into the code block, and the next key went into the code.
  const line = (await documentView.locator(".cm-line").boundingBox())!;
  await page.mouse.click(line.x + 1, line.y + line.height / 2);
  await expect(documentView.locator(".cm-content")).toBeFocused();
  const last = await centerOf(images.last().locator("img"));
  await page.mouse.click(last.x, last.y);
  await expect(documentView).toBeFocused();
  await page.keyboard.type("c");
  // From the split's Markdown pane, Chromium extended the pane's selection
  // to its start, and the next key replaced the Markdown before the caret.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await caretInMarkdown("Last line.");
  await shiftClickAt(await centerOf(rules.last()));
  await expect(documentView).toBeFocused();
  await page.keyboard.type("d");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["```\nconst alpha = 1;\n```", "Above.", "a", "b", "Middle.", "d", "c", "Last line."].join("\n\n") + "\n");
});

test("Shift+click on a code block's code or a frontmatter cell from elsewhere puts the caret at the click", async () => {
  const file = path.join(directory, "shift-click-code-frontmatter.md");
  await writeFile(file, "---\ntitle: Survey\n---\n\n```\nconst alpha = 1;\nconst beta = 2;\n```\n\nLast line.\n");
  await launch(file);
  const table = page.locator(".frontmatter-table");
  await expect(table).toBeVisible();
  const code = page.locator(".milkdown .ProseMirror .cm-content");
  /** The point `fraction` of the way across the character at `index` of
   *  the frontmatter cell that reads `text`. */
  const pointInCell = (text: string, index: number, fraction: number) =>
    table.locator(".frontmatter-edit", { hasText: new RegExp(`^${text}$`) }).evaluate((cell, [index, fraction]) => {
      const range = document.createRange();
      range.setStart(cell.firstChild!, index);
      range.setEnd(cell.firstChild!, index + 1);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width * fraction, y: box.top + box.height / 2 };
    }, [index, fraction] as const);
  // CodeMirror selected from the block's own cursor, at its start, to the
  // click, and the next key replaced the code before the click.
  await clickOn("Last line.", -1, 0.75);
  await shiftClickAt(await pointOn("const beta = 2;", 6, 0.25));
  await expect(code).toBeFocused();
  await page.keyboard.type("x");
  // From the document, Chromium extended its selection to the start of the
  // body, and the next key replaced the body. Each click on the last line is
  // at another place, so none of them counts as a double-click.
  await clickOn("Last line.", 0, 0.25);
  await page.keyboard.press("End");
  await shiftClickAt(await pointInCell("title", 2, 0.25));
  await page.keyboard.type("z");
  // From the split's Markdown pane, Chromium extended the pane's selection
  // to its start, and the next key replaced the Markdown before the caret.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await caretInMarkdown("Last line.");
  await shiftClickAt(await pointInCell("Survey", 3, 0.25));
  await page.keyboard.type("y");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("---\ntiztle: Suryvey\n---\n\n```\nconst alpha = 1;\nconst xbeta = 2;\n```\n\nLast line.\n");
});

test("a click or Shift+click on the frontmatter table's caption or beside the table leaves focus where it was", async () => {
  const file = path.join(directory, "frontmatter-caption-click.md");
  await writeFile(file, "---\ntitle: Survey\n---\n\nFirst line.\n\nLast line.\n");
  await launch(file);
  const table = page.locator(".frontmatter-table");
  await expect(table).toBeVisible();
  // Chromium moved focus to the page, and the next key was lost.
  await clickOn("Last line.", -1, 0.75);
  const wrap = (await page.locator(".frontmatter-table-wrap").boundingBox())!;
  const box = (await table.boundingBox())!;
  await page.mouse.click((box.x + box.width + wrap.x + wrap.width) / 2, box.y + box.height / 2);
  await expect(page.locator(".milkdown .ProseMirror")).toBeFocused();
  await page.keyboard.type("a");
  // From the split's Markdown pane, a Shift+click on the caption extended the
  // pane's selection to its start, and the next key replaced the Markdown
  // before the caret.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await caretInMarkdown("First line.");
  await shiftClickAt(await centerOf(page.locator(".frontmatter-tab")));
  await expect(page.locator(".editor-pane-raw .cm-content")).toBeFocused();
  await page.keyboard.type("b");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("---\ntitle: Survey\n---\n\nFirst line.b\n\nLast line.a\n");
});

test("the block handle's add button from a code block puts the next key in the new paragraph", async () => {
  const file = path.join(directory, "block-handle-add-from-code.md");
  await writeFile(file, ["```\nconst alpha = 1;\n```", "First line.", "Last line."].join("\n\n") + "\n");
  await launch(file);
  const documentView = page.locator(".milkdown .ProseMirror");
  const line = (await documentView.locator(".cm-line").boundingBox())!;
  await page.mouse.click(line.x + 1, line.y + line.height / 2);
  await expect(documentView.locator(".cm-content")).toBeFocused();
  // Show the handle of the first paragraph and click its add button, once
  // Crepe has moved the handle beside the paragraph from the code block.
  const paragraph = await centerOf(documentView.locator("p", { hasText: "First line." }));
  await page.mouse.move(paragraph.x, paragraph.y, { steps: 4 });
  const add = page.locator(".milkdown-block-handle[data-show=true] .operation-item").first();
  let button = { x: 0, y: 0 };
  await expect.poll(async () => {
    button = await centerOf(add);
    return Math.abs(button.y - paragraph.y) < 8;
  }).toBe(true);
  await page.mouse.move(button.x, button.y, { steps: 6 });
  await page.mouse.click(button.x, button.y);
  // Crepe focused the document before it put the paragraph in, which put
  // focus back into the code block, so the next key went into the code.
  await expect(documentView).toBeFocused();
  await page.keyboard.type("a");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["```\nconst alpha = 1;\n```", "First line.", "a", "Last line."].join("\n\n") + "\n");
});

test("a Shift+drag from a link's text scrolls the document while the pointer is below it", async () => {
  const file = path.join(directory, "shift-drag-scroll.md");
  const lines = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} has some words.`);
  await writeFile(file, ["Start [anchor](https://example.com/a) here.", ...lines].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror > p")).toHaveCount(61);
  const area = page.locator(".editor-area");
  const scrollTop = () => area.evaluate((element) => element.scrollTop);
  expect(await area.evaluate((element) => element.scrollHeight > element.clientHeight * 2)).toBe(true);
  await clickOn("Start ", 2, 0.25);
  const press = await pointOn("anchor", 2, 0.25);
  const areaBox = (await area.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  // The pointer rests below the document, over the status bar.
  await page.mouse.move(press.x, areaBox.y + areaBox.height + 8, { steps: 5 });
  await expect.poll(scrollTop).toBeGreaterThan(areaBox.height);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const selected = await page.evaluate(() => document.getSelection()!.toString());
  expect(selected.startsWith("art anchor here.")).toBe(true);
  // The selection follows to the bottom edge of the scrolled document.
  const last = await page.locator(".milkdown .ProseMirror > p").evaluateAll((blocks, bottom) => {
    const shown = blocks.filter((block) => block.getBoundingClientRect().bottom <= bottom);
    return shown[shown.length - 1]!.textContent;
  }, areaBox.y + areaBox.height);
  expect(selected).toContain(last);
  // The document stops scrolling once the button is released.
  const released = await scrollTop();
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBe(released);
});

test("a Shift+drag from a link's text keeps its anchor, and goes on from the selection's anchor after the document changes", async () => {
  const file = path.join(directory, "shift-drag-edit.md");
  await writeFile(file, [
    "Start [anchor](https://example.com/a) here and more words.",
    "| Head A | Head B |\n| --- | --- |\n| one |  |",
    "Typed here and then [link](https://example.com/l) after it.",
    "End line near the end.",
  ].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(2);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const selected = () => page.evaluate(() => document.getSelection()!.toString());
  // prosemirror-tables turns a selection that ends at the start of a cell
  // into one of the paragraph it starts in, which moved the anchor to the
  // paragraph's start for the rest of the drag.
  await clickOn(" here and more words.", 3, 0.25);
  let point = await pointOn("anchor", 2, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const empty = (await page.locator(".milkdown .ProseMirror td").nth(1).boundingBox())!;
  await page.mouse.move(empty.x + empty.width / 2, empty.y + empty.height / 2, { steps: 4 });
  await expect.poll(selected).toBe("Start anchor here and more words.");
  point = await pointOn(" here and more words.", 15, 0.5);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect.poll(selected).toBe("re and more ");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  // A typed closing `~~` becomes strikethrough once the caret leaves it, here
  // on the press, which takes the four tildes out. The drag went on from a
  // position four characters past the caret.
  await clickOn("Typed here and then ", 9, 0.75);
  await page.keyboard.type(" ~~struck~~");
  point = await pointOn("link", 2, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveText("struck");
  point = await pointOn(" after it.", 4, 0.25);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(selected).toBe(" and then link aft");
  await page.keyboard.press("Backspace");
  // Backspace with the button still down took the selected text out, and the
  // drag then reached past the end of the document.
  await clickOn("End line near the end.", 14, 0.25);
  point = await pointOn("anchor", 2, 0.25);
  await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.keyboard.up("Shift");
  await page.keyboard.press("Backspace");
  point = await pointOn("the end.", 4, 0.25);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(selected).toBe("the ");
  await page.keyboard.type("Q");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Start [an](https://example.com/a)Qend.\n");
  expect(errors).toEqual([]);
});

test("text typed, composed or pasted right after a link goes after it", async () => {
  const file = path.join(directory, "after-link.md");
  await writeFile(file, [
    "End [one](https://example.com/1)",
    "Click [two](https://example.com/2)",
    "Arrow [three](https://example.com/3)",
    "- item [four](https://example.com/4)\n- second",
    "| Cell |\n| --- |\n| in [five](https://example.com/5) |",
    "Composed [six](https://example.com/6)",
    "Pasted [seven](https://example.com/7)",
  ].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(7);
  /** Click the text before a link, then press End. */
  const endOf = async (text: string) => {
    await clickOn(text, 0, 0.5);
    await page.keyboard.press("End");
  };
  await endOf("End ");
  await page.keyboard.type("a");
  // A click on the right half of the link's last character.
  await clickOn("two", -1, 0.75);
  await page.keyboard.type("b");
  // Right from inside the link, which Crepe's virtual cursor handles.
  await clickOn("three", -1, 0.25);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("c");
  // Crepe's list item views put the selection back a frame after they are
  // drawn, which clears the marks set for the caret.
  await endOf("item ");
  await page.waitForTimeout(300);
  await page.keyboard.type("d");
  await endOf("in ");
  await page.keyboard.type("e");
  await endOf("Composed ");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await session.send("Input.insertText", { text: "か" });
  await endOf("Pasted ");
  await app!.evaluate(({ clipboard }) => clipboard.writeText("f"));
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page).toHaveTitle("after-link.md — md-easy");
  const blocks = (await readFile(file, "utf8")).split("\n\n");
  expect.soft(blocks.slice(0, 4)).toEqual([
    "End [one](https://example.com/1)a",
    "Click [two](https://example.com/2)b",
    "Arrow [three](https://example.com/3)c",
    "- item [four](https://example.com/4)d\n- second",
  ]);
  expect.soft(blocks[4]).toMatch(/^\| in \[five\]\(https:\/\/example\.com\/5\)e *\|$/m);
  expect(blocks.slice(5)).toEqual(["Composed [six](https://example.com/6)か", "Pasted [seven](https://example.com/7)f\n"]);
});

test("typing over a link's selected text keeps the link", async () => {
  const file = path.join(directory, "over-link.md");
  await writeFile(file, "A [word](https://example.com/a) b.\n\nIntro [link](https://example.com/b)\n\nC [text](https://example.com/c) d.\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(3);
  await selectText("word");
  await page.keyboard.type("new");
  // The last character, selected from the link's end. With the URL drawn
  // before the selection's end, Chromium typed it outside the link.
  await clickOn("Intro ", 0, 0.5);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("ks");
  await selectText("text");
  await app!.evaluate(({ clipboard }) => clipboard.writeText("pasted"));
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.type("xy");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "A [new](https://example.com/a) b.\n\nIntro [links](https://example.com/b)\n\nC [pastedxy](https://example.com/c) d.\n",
  );
});

test("an input method's composition right after a link goes in once", async () => {
  const file = path.join(directory, "compose-after-link.md");
  await writeFile(file, [
    "Kana [one](https://example.com/1)",
    "Korean [two](https://example.com/2)",
    "A [three](https://example.com/3)s and more.",
    "Emptied [four](https://example.com/4)",
    "Text only [five](https://example.com/5)",
  ].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror .md-link-url")).toHaveCount(5);
  const session = await page.context().newCDPSession(page);
  /** Compose each text of `steps` in turn, as an input method does, then
   *  commit `commit`. An empty step empties the composition, which ends it. */
  const compose = async (steps: string[], commit: string) => {
    for (const text of steps) await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await session.send("Input.insertText", { text: commit });
  };
  /** Click the text before a link, then press End. */
  const endOf = async (text: string) => {
    await clickOn(text, 0, 0.5);
    await page.keyboard.press("End");
  };
  // With the URL shown after the link, a composition of more than one step
  // went in twice.
  await endOf("Kana ");
  await compose(["か", "かな"], "かな");
  await endOf("Korean ");
  await compose(["ㅎ", "하", "한"], "한");
  await clickOn("three", -1, 0.75);
  await compose(["か", "", "な", "なに"], "なに");
  await endOf("Emptied ");
  await compose(["か", "", "な", "なに"], "なに");
  await page.keyboard.press("ControlOrMeta+s");
  const composed = [
    "Kana [one](https://example.com/1)かな",
    "Korean [two](https://example.com/2)한",
    "A [three](https://example.com/3)なにs and more.",
    "Emptied [four](https://example.com/4)なに",
  ];
  await expect.poll(() => readFile(file, "utf8")).toBe([...composed, "Text only [five](https://example.com/5)"].join("\n\n") + "\n");
  // The same steps with only the link text shown, which always worked.
  const settings = await page.evaluate(() => window.mdEasy!.invoke("load_settings"));
  await app!.evaluate(({ BrowserWindow }, changed) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("md-easy:event:settings-changed", changed);
  }, { ...settings, linkDisplay: "text-only" });
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(5);
  await expect(page.locator(".milkdown .ProseMirror .md-link-url")).toHaveCount(0);
  await endOf("Text only ");
  await compose(["か", "かな"], "かな");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([...composed, "Text only [five](https://example.com/5)かな"].join("\n\n") + "\n");
});

test("text typed where a link's whole text was deleted is plain", async () => {
  const file = path.join(directory, "deleted-link.md");
  await writeFile(file, "A [link](https://example.com/a) b.\n\nC [text](https://example.com/c) d.\n\nE [word](https://example.com/e) f.\n\nG [h](https://example.com/g)s more.\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(4);
  // ProseMirror keeps the deleted text's link for the next character typed.
  await selectText("link");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("xy");
  await selectText("text");
  await page.keyboard.press("ControlOrMeta+x");
  await page.keyboard.type("zw");
  // On the link's side, after typing over the link's text and after Left at
  // its end, the link came back for the next character.
  await selectText("word");
  await page.keyboard.type("q");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("r");
  await clickOn("s more.", 0, 0.75);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("t");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("A xy b.\n\nC zw d.\n\nE r f.\n\nG ts more.\n");
});

test("plain text dropped on a link does not take the link", async () => {
  const file = path.join(directory, "drop-on-link.md");
  await writeFile(file, "First.\n\nIntro [link](https://example.com/a)\n\nA [more](https://example.com/b)s and more.\n");
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror a")).toHaveCount(2);
  /** Drop `text` as plain text at a point, through Chromium's drag emulation. */
  const dropText = async (text: string, point: { x: number; y: number }) => {
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [{ mimeType: "text/plain", data: text }], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data });
    }
    await cdp.detach();
  };
  // ProseMirror gave the text the marks under the pointer, and Crepe's drop
  // indicator put it in a block of its own as a new link to the same target.
  await dropText("dropped", await pointOn("link", -1, 0.75));
  await expect(page.locator(".milkdown .ProseMirror p", { hasText: "dropped" })).toHaveCount(1);
  const url = (await page.locator(".milkdown .ProseMirror .md-link-url").nth(1).boundingBox())!;
  await dropText("again", { x: url.x + url.width / 2, y: url.y + url.height / 2 });
  await expect(page.locator(".milkdown .ProseMirror p", { hasText: "again" })).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "First.\n\ndropped\n\nIntro [link](https://example.com/a)\n\nagain\n\nA [more](https://example.com/b)s and more.\n",
  );
});

test("Left at a link's end where text follows types into the link", async () => {
  const file = path.join(directory, "link-side.md");
  await writeFile(file, "A [link](https://example.com/b)s and more.\n");
  await launch(file);
  // Left first moves to the link's end, then keeps the caret there on the
  // link's side.
  await clickOn("s and more.", 0, 0.75);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("xyz");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("A [linkxyz](https://example.com/b)s and more.\n");
});

test("the caret at a link's end is drawn after its URL, and before it on the link's side", async () => {
  const file = path.join(directory, "link-caret.md");
  await writeFile(file, "Intro [link](https://example.com/a)\n\nA [link](https://example.com/b)s and more.\n\nTwo [one](https://example.com/1)[two](https://example.com/2) end\n");
  await launch(file);
  /** Where the virtual cursor draws the caret, and the edges of the URL
   *  shown after the link of paragraph `index`, in pixels. */
  const measure = (index: number) =>
    page.evaluate((index) => {
      const editor = document.querySelector(".milkdown .ProseMirror")!;
      const cursor = editor.querySelector<HTMLElement>(".prosemirror-virtual-cursor")!;
      const url = editor.querySelectorAll("p")[index]!.querySelector(".md-link-url")!.getBoundingClientRect();
      return { caret: editor.getBoundingClientRect().left + parseFloat(cursor.style.left), left: url.left, right: url.right };
    }, index);
  await clickOn("Intro ", 0, 0.5);
  await page.keyboard.press("End");
  await expect.poll(async () => {
    const { caret, right } = await measure(0);
    return Math.abs(caret - right);
  }).toBeLessThanOrEqual(2);
  const before = (await measure(0)).caret;
  await page.keyboard.type("x");
  // The typed character shows where the caret was.
  await expect.poll(async () => (await measure(0)).caret).toBeGreaterThan(before);
  expect((await measure(0)).caret - before).toBeLessThan(20);
  await clickOn("s and more.", 0, 0.75);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => {
    const { caret, right } = await measure(1);
    return Math.abs(caret - right);
  }).toBeLessThanOrEqual(2);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => {
    const { caret, left } = await measure(1);
    return caret - left;
  }).toBeLessThanOrEqual(0);
  // Between two links, Right keeps the caret in place on the second link's
  // side, where typed text joins that link after the first link's URL.
  await clickOn("one", -1, 0.75);
  await expect.poll(async () => {
    const { caret, right } = await measure(2);
    return Math.abs(caret - right);
  }).toBeLessThanOrEqual(2);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".prosemirror-virtual-cursor")).toHaveClass(/prosemirror-virtual-cursor-right/);
  const { caret, right } = await measure(2);
  expect(Math.abs(caret - right)).toBeLessThanOrEqual(2);
});

test("a click on the URL shown after a link puts the caret at the link's end, and Ctrl or Cmd+click opens that link", async () => {
  const file = path.join(directory, "click-url.md");
  const blocks = [
    "Intro [one](https://example.com/1)",
    "Intro [two](https://example.com/2)",
    "Intro [three](https://example.com/3)",
    "A [four](https://example.com/4)s and more.",
    "- item [five](https://example.com/5)\n- second",
    "B [six](https://example.com/6) and then more.",
    "C [seven](https://example.com/7)[eight](https://example.com/8) end.",
  ];
  await writeFile(file, blocks.join("\n\n") + "\n");
  await launch(file);
  await app!.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const urls = page.locator(".milkdown .ProseMirror .md-link-url");
  await expect(urls).toHaveCount(8);
  /** Click `fraction` of the way across the URL shown after link `index`. */
  const clickUrl = async (index: number, fraction: number) => {
    const box = (await urls.nth(index).boundingBox())!;
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  };
  // Chromium put a click on the URL's text, past its first few pixels, at
  // the start of the paragraph.
  for (const [index, fraction, typed] of [[0, 0.05, "a"], [1, 0.5, "b"], [2, 0.95, "c"], [3, 0.5, "d"], [4, 0.5, "e"]] as const) {
    await clickUrl(index, fraction);
    await page.keyboard.type(typed);
  }
  await page.keyboard.press("ControlOrMeta+s");
  const edited = [
    "Intro [one](https://example.com/1)a",
    "Intro [two](https://example.com/2)b",
    "Intro [three](https://example.com/3)c",
    "A [four](https://example.com/4)ds and more.",
    "- item [five](https://example.com/5)e\n- second",
  ];
  await expect.poll(() => readFile(file, "utf8")).toBe([...edited, ...blocks.slice(5)].join("\n\n") + "\n");
  // Shift+click on the URL extends the selection to the link's end.
  await clickOn(" and then more.", 10, 0.25);
  await page.keyboard.down("Shift");
  await clickUrl(5, 0.5);
  await page.keyboard.up("Shift");
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboardText).toBe(" and then ");
  // Ctrl or Cmd+click on the URL opens the link before it, also when another
  // link follows right after it. It opened nothing and selected the whole
  // paragraph, so the next key replaced it. Now the caret goes to the end of
  // the link, as on a plain click on the URL.
  const ctrlClickUrl = async (index: number) => {
    await page.keyboard.down("ControlOrMeta");
    await clickUrl(index, 0.5);
    await page.keyboard.up("ControlOrMeta");
  };
  await ctrlClickUrl(6);
  // No link preview shows on the URL, so none covers the line above.
  await ctrlClickUrl(5);
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "opened"))).toEqual(["https://example.com/7", "https://example.com/6"]);
  await page.keyboard.type("f");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([...edited, "B [six](https://example.com/6)f and then more.", blocks[6]].join("\n\n") + "\n");
});

test("the link preview shows the link whose text is under the pointer, never the one after it", async () => {
  const file = path.join(directory, "link-preview.md");
  await writeFile(file, ["C [seven](https://example.com/7)[eight](https://example.com/8) end.", "Plain line."].join("\n\n") + "\n");
  await launch(file);
  const urls = page.locator(".milkdown .ProseMirror .md-link-url");
  await expect(urls).toHaveCount(2);
  // Crepe shows the preview only while the document has focus.
  await clickOn("Plain line.", 2, 0.5);
  const preview = page.locator(".milkdown-link-preview");
  // ProseMirror gives the position after a character for the pointer on its
  // right half, where the next link starts, and the preview showed that link.
  let point = await pointOn("seven", -1, 0.75);
  await page.mouse.move(point.x, point.y);
  await expect(preview).toHaveAttribute("data-show", "true");
  await expect(preview.locator(".link-display")).toHaveText("https://example.com/7");
  // The URL shown after a link is not link text, so no preview shows there.
  // It showed the next link, while a Ctrl or Cmd+click there opens this one.
  const url = (await urls.first().boundingBox())!;
  await page.mouse.move(url.x + url.width / 2, url.y + url.height / 2);
  await expect(preview).toBeHidden();
  point = await pointOn("eight", 1, 0.5);
  await page.mouse.move(point.x, point.y);
  await expect(preview).toHaveAttribute("data-show", "true");
  await expect(preview.locator(".link-display")).toHaveText("https://example.com/8");
});

test("the link preview's Remove and Edit act on the whole link, also one of an image and a caption", async () => {
  const file = path.join(directory, "link-preview-range.md");
  await writeFile(path.join(directory, "bar.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="#c33"/></svg>');
  await writeFile(file, ["[![Alt](bar.svg) caption](https://example.com/target)", "Mixed [a **bold** b](https://example.com/m) end.", "Plain line."].join("\n\n") + "\n");
  await launch(file);
  await expect.poll(() => page.locator(".milkdown .ProseMirror .milkdown-image-inline img").evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth)).toBe(48);
  // Crepe shows the preview only while the document has focus.
  await clickOn("Plain line.", 2, 0.5);
  const preview = page.locator(".milkdown-link-preview");
  /** Rest the pointer on `text` until the preview of `href` shows. */
  const hover = async (text: string, href: string) => {
    const point = await pointOn(text, 1, 0.5);
    await page.mouse.move(point.x, point.y);
    await expect(preview).toHaveAttribute("data-show", "true");
    await expect(preview.locator(".link-display")).toHaveText(href);
  };
  // The preview acted on the first node of the link, or the one under the
  // pointer, so Remove took the link off the image or the caption only, and
  // Edit gave only the bold text the new address.
  await hover(" caption", "https://example.com/target");
  await preview.locator(".link-remove-button").click();
  await expect(preview).toBeHidden();
  await hover("bold", "https://example.com/m");
  await preview.locator(".link-edit-button").click();
  await expect(page.locator(".milkdown-link-edit input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("https://example.com/new");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["![Alt](bar.svg) caption", "Mixed [a **bold** b](https://example.com/new) end.", "Plain line."].join("\n\n") + "\n");
});

test("a change the browser makes inside a link while the caret rests at its end keeps the link", async () => {
  const file = path.join(directory, "link-text-service.md");
  await writeFile(file, "Intro [lnk](https://example.com/a)\n\nFix [teh](https://example.com/b)\n");
  await launch(file);
  /** Click the end of the link that reads `text`, then replace `count`
   *  characters of its text from `offset` with `data` in the page, as a text
   *  suggestion or a spelling fix does, away from the caret. */
  const change = async (text: string, offset: number, count: number, data: string) => {
    await clickOn(text, -1, 0.75);
    await page.locator(".milkdown .ProseMirror a", { hasText: text }).evaluate((link, [offset, count, data]) => {
      const node = [...link.childNodes].find((child): child is Text => child instanceof Text)!;
      node.replaceData(offset, count, data);
    }, [offset, count, data] as const);
  };
  await change("lnk", 1, 0, "i");
  await change("teh", 1, 2, "he");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro [link](https://example.com/a)\n\nFix [the](https://example.com/b)\n");
});

test("End with the caret before images or formulas that start a line moves the caret to the end of the line", async () => {
  const file = path.join(directory, "image-end.md");
  await writeFile(path.join(directory, "image.png"), onePixelPng);
  await writeFile(file, [
    "Ends with ![End](end/missing.png)",
    "![Start](start/missing.png) starts here.",
    "![Pixel](image.png)![Gone](gone.png) start here.",
    "Break\\\n![Pixel](image.png) after a line break.",
    "| Cells |\n| --- |\n| ![Cell](cell/missing.png) in a cell |",
    "| Formulas |\n| --- |\n| $v$ in a formula cell |",
    "![Pixel](image.png)![Gone](gone.png) are selected.",
    "$x^2$ starts with a formula.",
    "![Pixel](image.png)$y$ start with an image.",
    "Break\\\n$z$ after a line break.",
    "Kept\\\n![Pixel](image.png)$k$ are selected past a line break.",
    "Twice\\\n![Pixel](image.png) is selected twice.",
    "Less\\\n$s$ is selected less.",
    "Home\\\n![Pixel](image.png) goes back home.",
    "Join\\\n![Pixel](image.png) joins the line above.",
    "Inserted\\\n![Pixel](image.png) takes inserted text.",
    "Emoji\\\n![Pixel](image.png) takes an emoji.",
    "Ends\\\n![Pixel](image.png) ends the inserted text.",
    "Composed\\\n![Pixel](image.png) takes a composition.",
    "Formula\\\n$c$ is composed over.",
    "Edge\\\n![Pixel](image.png)$e$ keeps the formula.",
    "Merged\\\n![Pixel](image.png) joins by composing.",
  ].join("\n\n") + "\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  await expect(editor.locator(".md-image-missing")).toHaveCount(5);
  const loaded = () => editor.getByRole("img", { name: "Pixel" }).evaluateAll((images) => images.filter((image) => image instanceof HTMLImageElement && image.naturalWidth > 0).length);
  await expect.poll(loaded).toBe(14);
  await expect(editor.locator("[data-type=math_inline]")).toHaveCount(8);
  /** Click at the end of the text on `line`'s last row, go to the start of
   *  that row with Home, press `keys` and type `text`, or put it in with
   *  `insert`. */
  const typeAfter = async (keys: string | string[], line: Locator, text: string, insert: (text: string) => Promise<unknown> = (text) => page.keyboard.type(text)) => {
    await line.scrollIntoViewIfNeeded();
    const end = await line.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP));
      let last: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
      const range = document.createRange();
      range.selectNodeContents(last!);
      const box = [...range.getClientRects()].at(-1)!;
      return { x: box.right - 1, y: box.top + box.height / 2 };
    });
    await page.mouse.click(end.x, end.y);
    await page.keyboard.press("Home");
    for (const key of [keys].flat()) await page.keyboard.press(key);
    await insert(text);
  };
  const paragraph = (text: string) => editor.locator("p").filter({ hasText: text });
  await typeAfter("End", paragraph("starts here."), "1");
  await typeAfter("End", paragraph("start here."), "2");
  await typeAfter("End", paragraph("after a line break.").first(), "3");
  await typeAfter("End", editor.locator("td").filter({ hasText: "in a cell" }), "4");
  // Shift+End selects the whole line, which the typing replaces.
  await typeAfter("Shift+End", paragraph("are selected."), "5");
  await typeAfter("End", paragraph("starts with a formula."), "6");
  await typeAfter("End", paragraph("start with an image."), "7");
  await typeAfter("End", paragraph("after a line break.").last(), "8");
  await typeAfter("End", editor.locator("td").filter({ hasText: "in a formula cell" }), "9");
  // After a line break, Shift+End selects the line without the break, which
  // Chromium's own Shift+End takes in too.
  await typeAfter("Shift+End", paragraph("are selected past a line break."), "0");
  // Chromium moves the anchor before the break when it extends the selection
  // again, and the selection keeps it after the break.
  await typeAfter(["Shift+End", "Shift+End"], paragraph("is selected twice."), "a");
  await typeAfter(["Shift+End", "Shift+ArrowLeft"], paragraph("is selected less."), "b");
  await typeAfter(["Shift+End", "Shift+Home"], paragraph("goes back home."), "c");
  // Typing over a selection that ends right after the break replaces it.
  await typeAfter("Shift+ArrowLeft", paragraph("joins the line above."), "d");
  // Text that comes without a key press, as from an input method or the emoji
  // panel, and a character Chromium types as two halves keep the break too.
  await typeAfter("Shift+End", paragraph("takes inserted text."), "é", (text) => page.keyboard.insertText(text));
  const session = await page.context().newCDPSession(page);
  await typeAfter("Shift+End", paragraph("takes an emoji."), "😀", (text) => session.send("Input.dispatchKeyEvent", { type: "char", text, unmodifiedText: text }));
  await typeAfter("Shift+ArrowLeft", paragraph("ends the inserted text."), "è", (text) => page.keyboard.insertText(text));
  // So does an input method's composition, which Chromium cannot cancel.
  const compose = async (text: string) => {
    await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await session.send("Input.insertText", { text });
  };
  await typeAfter("Shift+End", paragraph("takes a composition."), "漢", compose);
  await typeAfter("Shift+End", paragraph("is composed over."), "字", compose);
  await typeAfter("Shift+ArrowRight", paragraph("keeps the formula."), "界", compose);
  await typeAfter("Shift+ArrowLeft", paragraph("joins by composing."), "合", compose);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page).toHaveTitle("image-end.md — md-easy");
  const blocks = (await readFile(file, "utf8")).split("\n\n");
  expect(blocks.slice(0, 4)).toEqual([
    "Ends with ![End](end/missing.png)",
    "![Start](start/missing.png) starts here.1",
    "![Pixel](image.png)![Gone](gone.png) start here.2",
    "Break\\\n![Pixel](image.png) after a line break.3",
  ]);
  expect(blocks[4]).toMatch(/^\| !\[Cell\]\(cell\/missing\.png\) in a cell4 *\|$/m);
  expect(blocks[5]).toMatch(/^\| \$v\$ in a formula cell9 *\|$/m);
  expect(blocks.slice(6)).toEqual([
    "5",
    "$x^2$ starts with a formula.6",
    "![Pixel](image.png)$y$ start with an image.7",
    "Break\\\n$z$ after a line break.8",
    "Kept\\\n0",
    "Twice\\\na",
    "Less\\\nb.",
    "Home\\\nc![Pixel](image.png) goes back home.",
    "Joind![Pixel](image.png) joins the line above.",
    "Inserted\\\né",
    "Emoji\\\n😀",
    "Endsè![Pixel](image.png) ends the inserted text.",
    "Composed\\\n漢",
    "Formula\\\n字",
    "Edge\\\n界$e$ keeps the formula.",
    "Merged合![Pixel](image.png) joins by composing.\n",
  ]);
});

test("the block handle of a line with a wide missing image chip stays beside the line", async () => {
  const file = path.join(directory, "chip-handle.md");
  const chipImage = "![Q3](charts/quarterly/q3-sales-by-region.png)";
  const markdown = `Sales are in the ${chipImage} chart and they look good.\n\n- [ ] Sales are in the ${chipImage} chart now.\n- [ ] Plain task.\n`;
  await writeFile(file, markdown);
  await launch(file);
  const line = page.locator(".milkdown .ProseMirror > p").first();
  const chip = line.locator(".md-image-missing");
  await expect(chip).toBeVisible();
  // Crepe looks for the block under the pointer in the middle of the page,
  // which the chips cross.
  const middle = await page.locator(".milkdown .ProseMirror").evaluate((editor) => {
    const { left, width } = editor.getBoundingClientRect();
    return left + width / 2;
  });
  for (const crossing of [chip, page.locator(".milkdown .ProseMirror li .md-image-missing")]) {
    const box = (await crossing.boundingBox())!;
    expect(box.x).toBeLessThan(middle);
    expect(box.x + box.width).toBeGreaterThan(middle);
  }
  const handle = page.locator(".milkdown-block-handle");
  /** Rest the pointer on `block`'s first line, wait for the handle to show
   *  beside that block, and return the handle's left edge. */
  const handleLeft = async (block: Locator): Promise<number> => {
    const box = (await block.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 12);
    let left = Number.NaN;
    await expect.poll(async () => {
      const handleBox = await handle.boundingBox();
      if (!handleBox) return false;
      left = handleBox.x;
      const middleY = handleBox.y + handleBox.height / 2;
      return middleY > box.y && middleY < box.y + box.height && handleBox.x + handleBox.width <= box.x;
    }).toBe(true);
    return left;
  };
  await handleLeft(line);
  // The handle of a task with a chip is where it is for a task without one, not
  // over its checkbox.
  const tasks = page.locator(".milkdown .ProseMirror li");
  const plain = await handleLeft(tasks.nth(1));
  expect(await handleLeft(tasks.nth(0))).toBe(plain);
  await handleLeft(line);
  const chipBox = (await chip.boundingBox())!;
  // A click on the word before the chip puts the caret in it.
  await page.mouse.click(chipBox.x - 12, chipBox.y + chipBox.height / 2);
  await page.keyboard.type("X");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page).toHaveTitle("chip-handle.md — md-easy");
  const saved = await readFile(file, "utf8");
  // X went into "the", the word before the chip, and nothing else changed.
  const typed = saved.indexOf("X");
  expect(typed).toBeGreaterThanOrEqual(markdown.indexOf("the ![Q3]"));
  expect(typed).toBeLessThanOrEqual(markdown.indexOf(" ![Q3]"));
  expect(saved.slice(0, typed) + saved.slice(typed + 1)).toBe(markdown);
});

test("a missing image chip inside a text selection shows as selected", async () => {
  const file = path.join(directory, "chip-selection.md");
  await writeFile(file, "The chart ![Chart](charts/missing.png) shows the trend.\n");
  await launch(file);
  const line = page.locator(".milkdown .ProseMirror > p").first();
  const chip = line.locator(".md-image-missing");
  await expect(chip).toBeVisible();
  const fill = await chip.evaluate((element) => getComputedStyle(element).backgroundColor);
  const selected = await line.evaluate((element) => getComputedStyle(element, "::selection").backgroundColor);
  expect(selected).not.toBe(fill);
  await line.click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Shift+End");
  await expect(chip).toHaveCSS("background-color", selected);
  await page.keyboard.press("ArrowRight");
  await expect(chip).toHaveCSS("background-color", fill);
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

/** Roles a screen reader announces by name. */
const NAMED_ROLES = new Set([
  "button", "checkbox", "combobox", "graphics-document", "image", "link", "listbox", "menu", "menuitem",
  "navigation", "option", "radio", "searchbox", "slider", "switch", "tab", "textbox",
]);

/** The element with its two nearest ancestors, such as
 *  "svg < span.milkdown-icon < button.copy-button". Runs in the page. */
function describeElement(element: Element): string {
  const parts: string[] = [];
  for (let el: Element | null = element; el && parts.length < 3; el = el.parentElement) {
    parts.push(el.tagName.toLowerCase() + [...el.classList].map((name) => "." + name).join(""));
  }
  return parts.join(" < ");
}

test("the document view names every image and control it shows, and hides none that Tab reaches", async () => {
  const file = path.join(directory, "names.md");
  await writeFile(path.join(directory, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64"));
  await writeFile(file, [
    "# Names",
    "A [link](https://example.com) and math $E = mc^2$ in a line.",
    "- One\n- Two",
    "- [ ] Open task\n- [x] Done task",
    "```js\nlet x = 1;\n```",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    '![Pixel](image.png "Caption")',
    "```mermaid\ngraph TD; A-->B;\n```",
    "Last line.",
  ].join("\n\n") + "\n");
  await launch(file);
  const session = await page.context().newCDPSession(page);
  const editor = page.locator(".milkdown > .ProseMirror");
  const lastLine = editor.locator("p").filter({ hasText: "Last line." });
  const failures = new Set<string>();
  /** Record the images and controls in the document view that have no
   *  accessible name in Chromium's tree while the view is in `state`, such as
   *  "image svg < span.milkdown-icon < button.copy-button". Also record any
   *  element a Tab can reach inside an aria-hidden container, which a screen
   *  reader would focus without announcing. */
  const check = async (state: string) => {
    const { result } = await session.send("Runtime.evaluate", { expression: "document.querySelector('.crepe-root')" });
    const { nodes } = await session.send("Accessibility.queryAXTree", { objectId: result.objectId });
    for (const node of nodes) {
      const role = String(node.role?.value ?? "");
      if (node.ignored || !NAMED_ROLES.has(role) || String(node.name?.value ?? "").trim()) continue;
      const { object } = await session.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
      const described = await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () { return (${describeElement})(this); }`,
      });
      failures.add(`${state}: unnamed ${role} ${String(described.result.value)}`);
    }
    const hidden = '.crepe-root [aria-hidden="true"]';
    const focusable = await session.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `[...document.querySelectorAll('${hidden}, ${hidden} *')]
        .filter((el) => el.tabIndex >= 0).map((el) => (${describeElement})(el))`,
    });
    for (const element of focusable.result.value as string[]) failures.add(`${state}: focusable inside aria-hidden ${element}`);
  };
  // Crepe draws a code block, and its diagram, once the block is on screen.
  await page.locator(".milkdown-code-block").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".mermaid-preview svg")).toBeVisible();
  await check("at rest");
  await editor.locator("p").first().hover();
  await expect(page.locator(".milkdown-block-handle")).toHaveAttribute("data-show", "true");
  await check("block handle");
  await page.locator(".milkdown-code-block").first().hover();
  await page.locator(".milkdown-code-block .language-button").first().click();
  await expect(page.locator(".language-list [aria-selected]").first()).toBeVisible();
  await check("language picker");
  await lastLine.click();
  await editor.locator("a").hover();
  await expect(page.locator(".milkdown-link-preview")).toHaveAttribute("data-show", "true");
  await check("link preview");
  // Keep the table clear of the top edge, so the column handle above it stays
  // on screen.
  const cell = editor.locator("td").first();
  await cell.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await cell.click();
  // Crepe shows the column handle for the hovered column, toggles the column's
  // menu when the handle is clicked, and hides the menu when the pointer leaves
  // the table. Where floating-ui puts the handle differs between machines, so
  // send the click to the handle itself, and hover and click again if a pointer
  // event closed the menu before it could be checked.
  const colHandle = page.locator('[data-role="col-drag-handle"]');
  const columnMenu = colHandle.locator(".button-group");
  await expect(async () => {
    await cell.hover();
    await expect(colHandle).toHaveAttribute("data-show", "true", { timeout: 1000 });
    if ((await columnMenu.getAttribute("data-show")) !== "true") await colHandle.dispatchEvent("click");
    await expect(columnMenu).toHaveAttribute("data-show", "true", { timeout: 1000 });
  }).toPass();
  await check("column handle");
  await lastLine.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await expect(page.locator(".milkdown-toolbar")).toHaveAttribute("data-show", "true");
  await check("selection toolbar");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.locator(".milkdown-slash-menu")).toHaveAttribute("data-show", "true");
  await check("slash menu");
  await page.keyboard.type("image");
  await expect(page.locator(".milkdown-slash-menu li.hover")).toHaveText("Image");
  await page.keyboard.press("Enter");
  await expect(page.locator(".milkdown-image-block .link-input-area")).toBeVisible();
  await check("empty image");
  await editor.locator(".katex").click();
  await expect(page.locator(".milkdown-latex-inline-edit")).toHaveAttribute("data-show", "true");
  await check("math field");
  expect([...failures]).toEqual([]);
});

test("a code block's tools show with a focus ring while they have keyboard focus, and the table's pointer controls take none", async () => {
  const file = path.join(directory, "focus.md");
  await writeFile(file, "First line.\n\n```js\nlet x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  await launch(file);
  // Keep the pointer off the code block, where hover alone shows the tools.
  await page.locator(".milkdown > .ProseMirror > p").first().hover();
  const language = page.locator(".milkdown-code-block .language-button");
  const copy = page.locator(".milkdown-code-block .copy-button");
  await expect(copy).toHaveCSS("opacity", "0");
  // The accent the page's own buttons ring with, in the form Chromium reports colors.
  const accent = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--doc-accent)";
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  /** Check that `tool` has focus, shows, and draws the page's solid accent
   *  focus ring. Sizes are left out, as Chromium snaps them to whole device
   *  pixels on a scaled display. */
  const expectFocusRing = async (tool: Locator): Promise<void> => {
    await expect(tool).toBeFocused();
    await expect(tool).toHaveCSS("opacity", "1");
    await expect(tool).toHaveCSS("outline-style", "solid");
    await expect(tool).toHaveCSS("outline-color", accent);
  };
  // Start on the first tool and move with Tab and Shift+Tab, so each tool gets keyboard focus.
  await language.focus();
  await page.keyboard.press("Tab");
  await expectFocusRing(copy);
  await page.keyboard.press("Shift+Tab");
  await expectFocusRing(language);
  // The table's buttons are invisible until hovered and do nothing from the keyboard.
  const tableButtons = page.locator(".milkdown-table-block .handle button");
  await expect(tableButtons.first()).toBeAttached();
  expect(await tableButtons.evaluateAll((buttons) => buttons.filter((button) => button.tabIndex >= 0).map((button) => button.className)))
    .toEqual([]);
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

test("the slash menu tells screen readers which block is highlighted", async () => {
  const file = path.join(directory, "slash.md");
  await writeFile(file, "First line.\n");
  await launch(file);
  const cdp = await page.context().newCDPSession(page);
  /** The option Chromium reports as the document editor's active descendant. */
  const activeOption = async (): Promise<string | null> => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const editor = nodes.find((node) => node.role?.value === "textbox" && node.name?.value === "Document editor");
    const target = editor?.properties?.find((property) => property.name === "activedescendant")?.value.relatedNodes?.[0];
    const option = target && nodes.find((node) => node.backendDOMNodeId === target.backendDOMNodeId);
    return option ? `${option.role?.value} ${option.name?.value}` : null;
  };
  await page.locator(".milkdown .ProseMirror p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // Focus stays in the document while the arrow keys move the menu's highlight.
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
  await expect.poll(activeOption).toBe("option Text");
  await page.keyboard.press("ArrowDown");
  await expect.poll(activeOption).toBe("option Heading 1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Insert block" })).toBeHidden();
  await expect.poll(activeOption).toBeNull();
  await expect(page.locator(".milkdown > .ProseMirror")).not.toHaveAttribute("aria-controls");
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

test("typed dollar amounts and tildes stay text while a typed formula becomes math", async () => {
  const file = path.join(directory, "prices.md");
  await writeFile(file, "Start.\n");
  await launch(file);
  await typeAtEnd(
    page.locator(".milkdown .ProseMirror p").first(),
    " Tickets cost $5 for kids and $10, or $5-$10. Expect ~5 to ~10 or ~5-~10 minutes.",
  );
  await page.keyboard.press("Enter");
  // A closing `$` waits for the next character, and Enter decides it too.
  await page.keyboard.type("Inline $E=mc^2$ math and $x$");
  await page.keyboard.press("Enter");
  // A tilde right after a letter outside the Basic Multilingual Plane opens
  // nothing either.
  await page.keyboard.type("End 𝑥~a~ b.");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(2);
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe(
      "Start. Tickets cost \\$5 for kids and \\$10, or \\$5-\\$10. Expect \\~5 to \\~10 or \\~5-\\~10 minutes.\n\n" +
        "Inline $E=mc^2$ math and $x$\n\nEnd 𝑥\\~a\\~ b.\n",
    );
});

test("a character composed right after a typed closing mark is typed once and decides the mark", async () => {
  const file = path.join(directory, "composed.md");
  await writeFile(file, "Start.\n");
  await launch(file);
  const session = await page.context().newCDPSession(page);
  /** Compose through Chromium's input method path, showing each of `marked`
   *  in turn and then committing `committed`. */
  const compose = async (marked: string[], committed: string) => {
    for (const text of marked) await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await session.send("Input.insertText", { text: committed });
  };
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").first(), " Then $x$");
  await compose(["k", "か"], "か");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(1);
  await page.keyboard.type(" and ~~old~~");
  // Striking during the composition restarted it, which typed "n" as well.
  await compose(["n", "な"], "な");
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveText("old");
  await page.keyboard.type(" end.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Start. Then $x$か and ~~old~~な end.\n");
});

test("a typed closing mark is decided in a heading, by Tab in a list and by a paste", async () => {
  const file = path.join(directory, "decided.md");
  await writeFile(file, "# Head\n\n- item\n- next\n\nOne.\n");
  await launch(file);
  // Milkdown gives a heading a new id after each key, which is no edit.
  await typeAtEnd(page.locator(heading), " $x$ and ~~old~~ end");
  // Tab redraws the list item, which puts back the cursor it saw then once
  // the next frame comes, unless a key came first.
  await typeAtEnd(page.locator(".milkdown .ProseMirror li p").nth(1), " $y$");
  await page.keyboard.press("Tab");
  await page.keyboard.type(" more");
  await app!.evaluate(({ clipboard }) => clipboard.writeText(", small"));
  await typeAtEnd(page.locator(".milkdown .ProseMirror > p").last(), " Let $z$");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("# Head $x$ and ~~old~~ end\n\n- item\n  - next $y$ more\n\nOne. Let $z$, small\n");
});

test("undo and redo keep pasted dollars as text and let a mark that a paste or Tab decided wait again", async () => {
  const file = path.join(directory, "undo-decided.md");
  await writeFile(file, "Start.\n\nOne.\n\n- one\n- two\n");
  await launch(file);
  const paragraphs = page.locator(".milkdown .ProseMirror > p");
  // Redo puts back pasted text, which keeps its dollars as text.
  await app!.evaluate(({ clipboard, ClipboardItem }) =>
    clipboard.write([new ClipboardItem({ "text/html": "<span>Let $x$</span>", "text/plain": "Let $x$" })]),
  );
  await typeAtEnd(paragraphs.first(), " ");
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+y");
  await page.keyboard.type(" be the input");
  // A pause makes the paste and Tab their own undo steps. Undoing one takes
  // back the formula or strikethrough it made, and the mark waits again.
  await app!.evaluate(({ clipboard }) => clipboard.writeText(", small"));
  await typeAtEnd(paragraphs.nth(1), " Let $y$");
  await page.waitForTimeout(700);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(0);
  await page.keyboard.type(" here");
  await typeAtEnd(page.locator(".milkdown .ProseMirror li p").nth(1), " ~old~");
  await page.waitForTimeout(700);
  await page.keyboard.press("Tab");
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveText("old");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.type(" new");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("Start. Let \\$x\\$ be the input\n\nOne. Let $y$ here\n\n- one\n- two ~~old~~ new\n");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(1);
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveText("old");
});

/** Run `act` while the page's animation frames wait, then run them, as on a
 *  busy machine whose next frame comes only after the keys typed meanwhile. */
async function lateFrame(act: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window);
    const late: FrameRequestCallback[] = [];
    let holding = true;
    window.requestAnimationFrame = (callback) => request((time) => (holding ? late.push(callback) : callback(time)));
    Object.assign(globalThis, {
      releaseFrames: () => {
        holding = false;
        window.requestAnimationFrame = request;
        for (const callback of late) request(callback);
      },
    });
  });
  await act();
  await page.evaluate(() => {
    const release: () => void = Reflect.get(globalThis, "releaseFrames");
    release();
  });
  await twoFrames();
}

test("keys typed fast right after Tab, Shift+Tab, undo, redo or Enter in a list stay where they were typed", async () => {
  const file = path.join(directory, "late-frame.md");
  await writeFile(file, "- one\n- two\n  - three\n- four\n- five\n");
  await launch(file);
  await throttleCpu(cpuThrottlingRate ?? 4);
  const items = page.locator(".milkdown .ProseMirror li p");
  // Each of these redraws a list item, which puts back the cursor it saw
  // then once the next frame comes. On a busy machine the keys typed before
  // that frame came first, and the text typed after it landed among them.
  /** Press `key`, type `fast` before the next frame and `then` after it. */
  const typeAround = async (key: string, fast: string, then: string) => {
    await lateFrame(async () => {
      await page.keyboard.press(key);
      await page.keyboard.type(fast);
    });
    await page.keyboard.type(then);
  };
  await typeAtEnd(items.nth(1), " $a$");
  await typeAround("Tab", " b", "c");
  await typeAtEnd(items.nth(2), " ~d~");
  await typeAround("Shift+Tab", " e", "f");
  // A pause makes Tab its own undo step, which undo and redo redraw.
  await typeAtEnd(items.nth(3), " ~g~");
  await page.waitForTimeout(700);
  await page.keyboard.press("Tab");
  await typeAround("ControlOrMeta+z", " hi", "j");
  await typeAtEnd(items.nth(4), " $k$");
  await page.waitForTimeout(700);
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+z");
  await typeAround("ControlOrMeta+y", " l", "m");
  await typeAround("Enter", "new", " item");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("- one\n  - two $a$ bc\n  - three ~~d~~ ef\n- four ~~g~~ hij\n  - five $k$ lm\n  - new item\n");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(2);
  await expect(page.locator(".milkdown .ProseMirror del")).toHaveText(["d", "g"]);
});

test("autosave in a pause writes a typed closing mark as Save would and leaves it waiting", async () => {
  const file = path.join(directory, "autosaved.md");
  await writeFile(file, "Start.\n\nNext.\n");
  await writeFile(
    path.join(directory, "profile", "settings.toml"),
    "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nautosaveEnabled = true\nautosaveIntervalSeconds = 5\n",
  );
  await launch(file);
  // Record the unsaved-changes prompts and answer Cancel.
  await app!.evaluate(({ dialog }) => {
    const prompts: string[] = [];
    Object.assign(globalThis, { prompts });
    dialog.showMessageBox = async (...args: unknown[]) => {
      prompts.push(String((args.at(-1) as { message?: unknown }).message));
      return { response: 0, checkboxChecked: false };
    };
  });
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").first(), " Tickets cost $5-$");
  // Autosave writes what Save would, and the `$` keeps waiting, so the digit
  // typed next still keeps it text.
  await expect.poll(() => readFile(file, "utf8"), { timeout: 20_000 }).toBe("Start. Tickets cost $5-$\n\nNext.\n");
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(0);
  await page.keyboard.type("10 each.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Start. Tickets cost \\$5-\\$10 each.\n\nNext.\n");
  await typeAtEnd(page.locator(".milkdown .ProseMirror p").nth(1), " Let $x$");
  await expect.poll(() => readFile(file, "utf8"), { timeout: 20_000 }).toBe("Start. Tickets cost \\$5-\\$10 each.\n\nNext. Let $x$\n");
  // Closing the tab makes the formula, which autosave has already saved.
  await expect(page).toHaveTitle("autosaved.md — md-easy");
  await page.getByRole("tab", { name: /autosaved\.md/ }).click({ button: "middle" });
  await expect(page.getByRole("tab", { name: /autosaved\.md/ })).toHaveCount(0);
  expect(await app!.evaluate(() => (globalThis as { prompts?: string[] }).prompts ?? [])).toEqual([]);
  expect(await readFile(file, "utf8")).toBe("Start. Tickets cost \\$5-\\$10 each.\n\nNext. Let $x$\n");
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

test("a file the document view cannot show opens in the Markdown view with a notice, and Try again shows it once fixed", async () => {
  const deep = path.join(directory, "deep.md");
  const normal = path.join(directory, "normal.md");
  // Nesting this deep overflows the Markdown parser's stack.
  await writeFile(deep, ">".repeat(10_000) + " deep\n");
  await writeFile(normal, "# Normal file\n");
  await launch(deep);
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText(
    "md-easy can't show deep.md in the Document view (Maximum call stack size exceeded), so it is open in the Markdown view.Try again",
  );
  const markdown = page.locator(".editor-pane-raw:not([hidden]) .cm-content");
  await expect(markdown).toContainText("> deep");
  await expect(page.locator(".editor-pane:not([hidden])")).toHaveCount(1);
  await expect(page.getByRole("radio", { name: "Markdown", exact: true })).toHaveAttribute("aria-checked", "true");

  // Startup finished, so the shortcuts work. Other tabs show no notice.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("tab", { name: "Untitled", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(notice).toHaveCount(0);
  await chooseOpen(normal);
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror h1")).toHaveText("Normal file");
  await expect(page.getByRole("radio", { name: "Document", exact: true })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("tab", { name: "deep.md", exact: true }).click();
  await expect(notice).toBeVisible();
  // Dismissing the notice puts focus in the Markdown view, not on the clicked
  // tab. Choosing Document tries again, and the failure brings the notice back.
  await notice.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(markdown).toBeFocused();
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await expect(notice).toBeVisible();
  await markdown.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Fixed\n\nNo longer deep.\n");
  await notice.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror h1")).toHaveText("Fixed");
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror")).toBeFocused();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Document", exact: true })).toHaveAttribute("aria-checked", "true");
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

test("Tab leaves the document view without typing spaces, and still nests a list item", async () => {
  const file = path.join(directory, "tab.md");
  await writeFile(file, "First line.\n\n- One\n- Two\n\n```js\nlet x = 1;\n```\n");
  await launch(file);
  const document = page.locator(".milkdown .ProseMirror");
  // Nothing follows the document, so Tab wraps to the first control, as it
  // does from the Markdown view.
  const next = page.getByRole("button", { name: "Application menu", exact: true });
  await document.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  // In a list Tab nests the item, and Esc then Tab leaves.
  await document.getByText("Two", { exact: true }).click();
  // On a fast machine Playwright can send Tab before ProseMirror has read the
  // caret the click placed, which no person can do. Wait a frame so it has.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  await page.keyboard.press("Tab");
  await expect(document.locator("li li")).toHaveText("Two");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  // Esc then Shift+Tab leaves a code block for the control before the document,
  // not for a code block or table button inside it.
  await page.locator(".milkdown-code-block .cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "New document", exact: true })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. Edited.\n\n- One\n  - Two\n\n```js\nlet x = 1;\n```\n");
});

/** Open a file in the split, by default one line, returning each pane's first line. */
async function openSplit(name: string, text = "First line.\n"): Promise<{ file: string; documentLine: Locator; markdownLine: Locator }> {
  const file = path.join(directory, name);
  await writeFile(file, text);
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

/** Make the main process never answer about an image, so a document view
 *  waits its full second for each image before it shows. */
async function holdImageAnswers(): Promise<void> {
  await app!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.ipc.handle("md-easy:image-url", () => new Promise(() => {}));
  });
}

test("typing in the split's Markdown pane while a reload from disk builds keeps the file's new text", async () => {
  await writeFile(path.join(directory, "pixel.png"), onePixelPng);
  const { file, documentLine, markdownLine } = await openSplit("reload-while-typing.md", "Old text.\n\n![pixel](pixel.png)\n");
  await expect(documentLine).toHaveText("Old text.");
  // Hold back the answer about the image, so the document pane built for the
  // reload waits a second for it. The Markdown pane from before the reload
  // stays on screen meanwhile.
  await holdImageAnswers();
  await writeFile(file, "New text from disk.\n\n![pixel](pixel.png)\n");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // The old document pane goes once the reload has replaced the tab's text.
  await page.waitForFunction(() => !document.querySelector(".editor-pane-wysiwyg:not([hidden])"), undefined, { polling: "raf" });
  await markdownLine.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Typed during the reload.");
  // The new document pane is still building, so the typing went to the old text.
  expect(await page.locator(".editor-pane-wysiwyg:not([hidden])").count()).toBe(0);
  await expect(documentLine).toHaveText("New text from disk.");
  await expect(markdownLine).toHaveText("New text from disk.");
  await expect(page).toHaveTitle("reload-while-typing.md — md-easy");
  // The panes built for the reload take typing.
  await typeAtEnd(markdownLine, " Typed after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("New text from disk. Typed after.\n\n![pixel](pixel.png)\n");
  await expect(documentLine).toHaveText("New text from disk. Typed after.");
});

test("switching tabs while a reload from disk builds shows the other tab, then the reloaded text", async () => {
  await writeFile(path.join(directory, "pixel.png"), onePixelPng);
  const file = path.join(directory, "reloaded.md");
  const other = path.join(directory, "other.md");
  await writeFile(file, "Old text.\n\n![pixel](pixel.png)\n");
  await writeFile(other, "Other file.\n");
  await launch(file);
  await chooseOpen(other);
  await expect(page).toHaveTitle("other.md — md-easy");
  await page.getByRole("tab", { name: "reloaded.md", exact: true }).click();
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const documentLine = page.locator(".editor-pane-wysiwyg:not([hidden]) .ProseMirror p").first();
  const markdownLine = page.locator(".editor-pane-raw:not([hidden]) .cm-line").first();
  await expect(documentLine).toHaveText("Old text.");
  await expect(markdownLine).toHaveText("Old text.");
  await holdImageAnswers();
  await writeFile(file, "New text from disk.\n\n![pixel](pixel.png)\n");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // Switch tabs while the document pane for the reload waits for its image.
  await page.waitForFunction(() => !document.querySelector(".editor-pane-wysiwyg:not([hidden])"), undefined, { polling: "raf" });
  await page.getByRole("tab", { name: "other.md", exact: true }).click();
  // The other tab's panes replace the Markdown pane from before the reload.
  await expect(documentLine).toHaveText("Other file.");
  await expect(markdownLine).toHaveText("Other file.");
  await expect(page.locator(".editor-pane:not([hidden])")).toHaveCount(2);
  await expect(page).toHaveTitle("other.md — md-easy");
  await page.getByRole("tab", { name: "reloaded.md", exact: true }).click();
  await expect(documentLine).toHaveText("New text from disk.");
  await expect(markdownLine).toHaveText("New text from disk.");
  await typeAtEnd(markdownLine, " Typed after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("New text from disk. Typed after.\n\n![pixel](pixel.png)\n");
  await expect(readFile(other, "utf8")).resolves.toBe("Other file.\n");
});

test("a Reload clicked while a layout switch builds the document view shows the file's new text", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), 'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\ndefaultView = "markdown"\n');
  await writeFile(path.join(directory, "pixel.png"), onePixelPng);
  const file = path.join(directory, "reload-during-switch.md");
  await writeFile(file, "Old text on disk.\n\n![pixel](pixel.png)\n");
  await launch(file);
  const documentLine = page.locator(".editor-pane-wysiwyg:not([hidden]) .ProseMirror p").first();
  const markdownLine = page.locator(".editor-pane-raw:not([hidden]) .cm-line").first();
  await expect(markdownLine).toHaveText("Old text on disk.");
  await writeFile(file, "New text from disk.\n\n![pixel](pixel.png)\n");
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  await holdImageAnswers();
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  // Reload while the document pane for the split waits for its image.
  await page.waitForFunction(() => document.querySelector(".editor-pane-wysiwyg") !== null, undefined, { polling: "raf" });
  await reload.click();
  // The build from the old text is done again from the new.
  await expect(documentLine).toHaveText("New text from disk.");
  await expect(markdownLine).toHaveText("New text from disk.");
  await expect(page).toHaveTitle("reload-during-switch.md — md-easy");
  await typeAtEnd(markdownLine, " Typed after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("New text from disk. Typed after.\n\n![pixel](pixel.png)\n");
  await expect(documentLine).toHaveText("New text from disk. Typed after.");
});

test("Split chosen while a reload from disk builds shows both panes with the file's new text", async () => {
  await writeFile(path.join(directory, "pixel.png"), onePixelPng);
  const file = path.join(directory, "split-during-reload.md");
  await writeFile(file, "Old text.\n\n![pixel](pixel.png)\n");
  await launch(file);
  const documentLine = page.locator(".editor-pane-wysiwyg:not([hidden]) .ProseMirror p").first();
  const markdownLine = page.locator(".editor-pane-raw:not([hidden]) .cm-line").first();
  await expect(documentLine).toHaveText("Old text.");
  await holdImageAnswers();
  await writeFile(file, "New text from disk.\n\n![pixel](pixel.png)\n");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // Choose Split while the document pane for the reload waits for its image.
  await page.waitForFunction(() => !document.querySelector(".editor-pane-wysiwyg:not([hidden])"), undefined, { polling: "raf" });
  const split = page.getByRole("radio", { name: "Split", exact: true });
  await split.click();
  await expect(split).toHaveAttribute("aria-checked", "true");
  // The window switches to the split once the reload's document pane shows.
  await expect(documentLine).toHaveText("New text from disk.");
  await expect(markdownLine).toHaveText("New text from disk.");
  await expect(page.locator(".editor-pane:not([hidden])")).toHaveCount(2);
  await typeAtEnd(markdownLine, " Typed after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("New text from disk. Typed after.\n\n![pixel](pixel.png)\n");
  await expect(documentLine).toHaveText("New text from disk. Typed after.");
});

test("a reload from disk while settings rebuild the split's document view leaves no undo or image answers from before", async () => {
  const file = path.join(directory, "reload-during-settings.md");
  await writeFile(file, "Old text.\n\n![pixel](pixel.png)\n");
  await launch(file);
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const documentLine = page.locator(".editor-pane-wysiwyg:not([hidden]) .ProseMirror p").first();
  const markdownLine = page.locator(".editor-pane-raw:not([hidden]) .cm-line").first();
  // The image is missing, and the document view keeps that answer.
  await expect(page.locator(".editor-pane-wysiwyg:not([hidden]) .md-image-missing")).toHaveCount(1);
  const settings = await page.evaluate(() => window.mdEasy!.invoke("load_settings"));
  await writeFile(path.join(directory, "pixel.png"), onePixelPng);
  await writeFile(file, "New text from disk.\n\n![pixel](pixel.png)\n");
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  // Answer each image after 900 ms, and hold the file read until released.
  // Electron keeps the handlers of ipcMain.handle in `_invokeHandlers`, and a
  // handler on the window's own `ipc` runs in their place.
  await app!.evaluate(({ BrowserWindow, ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler>;
    const imageUrl = handlers.get("md-easy:image-url")!;
    const invoke = handlers.get("md-easy:invoke")!;
    const read = new Promise((resolve) => Reflect.set(globalThis, "releaseRead", resolve));
    const { ipc } = BrowserWindow.getAllWindows()[0]!.webContents;
    ipc.handle("md-easy:image-url", async (event, ...args) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return imageUrl(event, ...args);
    });
    ipc.handle("md-easy:invoke", async (event, command, ...args) => {
      if (command === "read_file") await read;
      return invoke(event, command, ...args);
    });
  });
  await reload.click();
  // Edit the Markdown pane during the read. The edit's image is new to the
  // document view, so a rebuild of that view waits for its answer.
  await markdownLine.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" ![x](slow.png)");
  // Change a document setting, which builds the document view again.
  await app!.evaluate(({ BrowserWindow }, changed) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("md-easy:event:settings-changed", changed);
  }, { ...settings, mdBulletChar: settings.mdBulletChar === "*" ? "-" : "*" });
  await page.waitForFunction(() => document.querySelector(".editor-pane-wysiwyg[hidden]") && !document.querySelector(".editor-pane-wysiwyg:not([hidden])"));
  // While it builds, type once more, which schedules a mirror sync into it 120 ms
  // later, and let the read finish before that sync runs.
  await app!.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0]!.webContents.insertText("!");
    await new Promise((resolve) => setTimeout(resolve, 10));
    (Reflect.get(globalThis, "releaseRead") as () => void)();
  });
  // The document view is built from the new text and shows the image now on disk.
  await expect(page.locator(".editor-pane-wysiwyg:not([hidden]) .milkdown-image-block img")).toHaveAttribute("src", /^md-easy-file:/);
  await expect(documentLine).toHaveText("New text from disk.");
  await expect(markdownLine).toHaveText("New text from disk.");
  await expect(page).toHaveTitle("reload-during-settings.md — md-easy");
  // Its undo history starts at the reload.
  await documentLine.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.type(" Typed after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("New text from disk. Typed after.\n\n![pixel](pixel.png)\n");
  await expect(markdownLine).toHaveText("New text from disk. Typed after.");
});

/** Drop files from the desktop onto an element, at `position` in its box or
 *  in its middle, through Chromium's drag emulation, so the app gets their
 *  real paths. */
async function dropFiles(target: Locator, files: string[], position?: { x: number; y: number }): Promise<void> {
  const box = (await target.boundingBox())!;
  const x = box.x + (position?.x ?? box.width / 2);
  const y = box.y + (position?.y ?? box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
  }
  await cdp.detach();
}

/** Write a small CSV file to drop, returning its path. */
async function csvFile(name: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, "a,b\n");
  return file;
}

/** Hold each request for a main process command, such as `read_image_bytes`,
 *  until `releaseHeld`, as for a large file or one on a slow share. With
 *  `first`, only that many of the first requests wait, and the main process
 *  answers the later ones at once (`passedAnswered`). Electron keeps the
 *  handlers of ipcMain.handle in `_invokeHandlers`, and a handler on the
 *  window's own `ipc` runs in their place. */
async function holdCommand(command: string, { first }: { first?: number } = {}): Promise<void> {
  await app!.evaluate(({ BrowserWindow, ipcMain }, [held, limit]) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const invoke = (Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler>).get("md-easy:invoke")!;
    const release = new Promise((resolve) => Reflect.set(globalThis, "releaseHeld", resolve));
    let asked = 0;
    BrowserWindow.getAllWindows()[0]!.webContents.ipc.handle("md-easy:invoke", async (event, name, ...args) => {
      if (name !== held) return invoke(event, name, ...args);
      asked += 1;
      if (limit !== null && asked > limit) {
        const passed = await invoke(event, name, ...args);
        Reflect.set(globalThis, "passedAnswered", Number(Reflect.get(globalThis, "passedAnswered") ?? 0) + 1);
        return passed;
      }
      Reflect.set(globalThis, "heldAsked", true);
      await release;
      const answer = await invoke(event, name, ...args);
      Reflect.set(globalThis, "heldAnswered", true);
      return answer;
    });
  }, [command, first ?? null] as const);
}

/** How many requests that `holdCommand` let go on without waiting the main
 *  process has answered. */
async function passedAnswered(): Promise<number> {
  return app!.evaluate(() => Number(Reflect.get(globalThis, "passedAnswered") ?? 0));
}

/** Resolve once the main process has sent the app its answer to the
 *  request that `holdCommand` held. */
async function untilHeldAnswered(): Promise<void> {
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "heldAnswered") === true)).toBe(true);
}

/** Resolve once the app has asked for the command that `holdCommand` holds. */
async function untilHeld(): Promise<void> {
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "heldAsked") === true)).toBe(true);
}

/** Let the requests that `holdCommand` holds go on. */
async function releaseHeld(): Promise<void> {
  await app!.evaluate(() => (Reflect.get(globalThis, "releaseHeld") as () => void)());
}

/** Whether a file or folder exists. */
async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

test("files dropped on the document go in where they were dropped", async () => {
  const file = path.join(directory, "drop-on-document.md");
  await writeFile(file, "First line.\n\nSecond line.\n\nThird line.\n");
  await launch(file);
  const secondLine = page.locator(".ProseMirror p", { hasText: "Second line." });
  const box = (await secondLine.boundingBox())!;
  // Low on the line, where Crepe's drop indicator marks the edge below it.
  await dropFiles(secondLine, [await csvFile("a.csv"), await csvFile("b.csv")], { x: box.width / 2, y: box.height - 2 });
  await expect(page.locator(".ProseMirror p").nth(3)).toHaveText(/b\.csv/);
  // The indicator goes once the files are in.
  await expect(page.locator(".milkdown-drop-indicator")).toBeHidden();
  // On the empty page below the text.
  const pageBox = (await page.locator(".editor-column").boundingBox())!;
  await dropFiles(page.locator(".editor-column"), [await csvFile("c.csv")], { x: pageBox.width / 2, y: pageBox.height - 40 });
  await expect(page.locator(".ProseMirror p").last()).toHaveText(/c\.csv/);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "First line.\n\nSecond line.\n\n[a.csv](attachments/a.csv)\n\n[b.csv](attachments/b.csv)\n\nThird line.\n\n[c.csv](attachments/c.csv)\n",
  );
});

test("a Markdown file dropped on the document opens without leaving the drop indicator behind", async () => {
  const file = path.join(directory, "drop-markdown.md");
  const other = path.join(directory, "other.md");
  await writeFile(file, "First line.\n\nSecond line.\n");
  await writeFile(other, "# Other\n");
  await launch(file);
  await dropFiles(page.locator(".ProseMirror p", { hasText: "Second line." }), [other]);
  await expect(page.locator(heading)).toHaveText("Other");
  await page.getByRole("tab", { name: /drop-markdown\.md/ }).click();
  await expect(page.locator(".ProseMirror p").first()).toHaveText("First line.");
  await expect(page.locator(".milkdown-drop-indicator").first()).toBeHidden();
});

test("a Markdown file dropped with other files opens in its own tab once the other files are in where they were dropped", async () => {
  const file = path.join(directory, "drop-mixed.md");
  const other = path.join(directory, "other.md");
  await writeFile(file, "First line.\n\nSecond line.\n\nThird line.\n");
  await writeFile(other, "# Other\n");
  await launch(file);
  await dropBelow(page.locator(".ProseMirror p", { hasText: "Second line." }), [await pngFile("pixel.png"), other, await csvFile("notes.csv")]);
  await expect(page.locator(`.editor-pane:not([hidden]) ${heading}`)).toHaveText("Other");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // The image and the link were in the document they were dropped on before
  // the new tab put it behind, so they did not wait for it to come back.
  const dropped = page.locator(".editor-pane[hidden] .ProseMirror", { hasText: "Second line." });
  await expect(dropped.locator(".milkdown-image-block")).toHaveCount(1);
  await expect(dropped.locator("p", { hasText: "notes.csv" })).toHaveCount(1);
  await page.getByRole("tab", { name: /drop-mixed\.md/ }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(
    /^First line\.\n\nSecond line\.\n\n!\[\]\(data:image\/png;base64,[^)]+\)\n\n\[notes\.csv\]\(attachments\/notes\.csv\)\n\nThird line\.\n$/,
  );
});

test("a Markdown file dropped with other files opens at once when the user shows another tab while those are read", async () => {
  const file = path.join(directory, "drop-switch.md");
  const shown = path.join(directory, "shown.md");
  const dropped = path.join(directory, "dropped.md");
  await writeFile(file, "First line.\n\nSecond line.\n\nThird line.\n");
  await writeFile(shown, "# Shown\n");
  await writeFile(dropped, "# Dropped\n");
  await launch(file);
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  const shownHeading = page.locator(`.editor-pane:not([hidden]) ${heading}`);
  await chooseOpen(shown);
  await expect(shownHeading).toHaveText("Shown");
  await tab(/drop-switch\.md/).click();
  const secondLine = page.locator(".editor-pane:not([hidden]) .ProseMirror p", { hasText: "Second line." });
  await expect(secondLine).toBeVisible();
  await holdCommand("read_image_bytes");
  await dropBelow(secondLine, [await pngFile("pixel.png"), dropped]);
  await untilHeld();
  // While the image is read, the user shows another tab. The Markdown file
  // opens then, as it would alone, rather than wait with the image.
  await tab(/shown\.md/).click();
  await expect(shownHeading).toHaveText("Dropped");
  await expect(page.getByRole("tab")).toHaveCount(3);
  await releaseHeld();
  // The image waits for its document. Back there, it goes in where it was
  // dropped, and that document stays in front.
  await tab(/drop-switch\.md/).click();
  await expect(page.locator(".editor-pane:not([hidden]) .milkdown-image-block")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(tab(/drop-switch\.md/)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p").first()).toHaveText("First line.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(
    /^First line\.\n\nSecond line\.\n\n!\[\]\(data:image\/png;base64,[^)]+\)\n\nThird line\.\n$/,
  );
});

test("two Markdown files dropped together each open in a tab of their own", async () => {
  const file = path.join(directory, "drop-two.md");
  const first = path.join(directory, "first.md");
  const second = path.join(directory, "second.md");
  await writeFile(file, "First line.\n\nSecond line.\n");
  await writeFile(first, "# First\n");
  await writeFile(second, "# Second\n");
  await launch(file);
  await dropFiles(page.locator(".ProseMirror p", { hasText: "Second line." }), [first, second]);
  await expect(page.locator(`.editor-pane:not([hidden]) ${heading}`)).toHaveText("Second");
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("tab", { name: /first\.md/ }).click();
  await expect(page.locator(`.editor-pane:not([hidden]) ${heading}`)).toHaveText("First");
  // The document they were dropped on is as it was.
  await page.getByRole("tab", { name: /drop-two\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p")).toHaveText(["First line.", "Second line."]);
  await expect(page.getByRole("tab", { name: /drop-two\.md/ }).locator(".tab-dot")).toBeHidden();
});

test("the files of a drop after one that cannot be read go in, and the drop's Markdown file opens", async () => {
  const file = path.join(directory, "drop-gone.md");
  const dropped = path.join(directory, "dropped.md");
  await writeFile(file, "First line.\n\nSecond line.\n");
  await writeFile(dropped, "# Dropped\n");
  await launch(file);
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const gone = await pngFile("gone.png");
  await holdCommand("read_image_bytes");
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [gone, await csvFile("good.csv"), dropped]);
  await untilHeld();
  // The image is deleted before it is read.
  await unlink(gone);
  await releaseHeld();
  await expect(page.locator(`.editor-pane:not([hidden]) ${heading}`)).toHaveText("Dropped");
  await page.getByRole("tab", { name: /drop-gone\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p")).toHaveText(["First line.", /good\.csv/, "Second line."]);
  expect(errors).toContainEqual(expect.stringContaining("md-easy: could not insert gone.png"));
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\n\n[good.csv](attachments/good.csv)\n\nSecond line.\n");
  expect(await readFile(path.join(directory, "attachments", "good.csv"), "utf8")).toBe("a,b\n");
  await expect(page.getByRole("tab", { name: /drop-gone\.md/ }).locator(".tab-dot")).toBeHidden();
});

test("a file dropped on a document that is saved in another folder while the file is read goes in beside it there", async () => {
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  await holdCommand("read_image_bytes");
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [await csvFile("data.csv")]);
  await untilHeld();
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await releaseHeld();
  await expect(page.locator(".ProseMirror p", { hasText: "data.csv" })).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toBe("First line.\n\n[data.csv](attachments/data.csv)\n\nSecond line.\n");
  expect(await readFile(path.join(directory, "moved", "attachments", "data.csv"), "utf8")).toBe("a,b\n");
  expect(await exists(path.join(directory, "original", "attachments"))).toBe(false);
});

test("a file dropped on a document whose Save As dialog is open once the file is read goes in beside it where it is saved", async () => {
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  await holdCommand("read_image_bytes");
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [await csvFile("data.csv")]);
  await untilHeld();
  // The user starts Save As during the read and is still in its dialog when
  // the read ends.
  const answerSave = await holdSaveDialog(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "saveAsked") === true)).toBe(true);
  await releaseHeld();
  await untilHeldAnswered();
  await answerSave();
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await expect(page.locator(".ProseMirror p", { hasText: "data.csv" })).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toBe("First line.\n\n[data.csv](attachments/data.csv)\n\nSecond line.\n");
  expect(await readFile(path.join(directory, "moved", "attachments", "data.csv"), "utf8")).toBe("a,b\n");
  expect(await exists(path.join(directory, "original", "attachments"))).toBe(false);
});

test("an image dropped on a document that is saved in another folder while the image is written is written again beside it there", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  await holdCommand("write_attachment");
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [await pngFile("pixel.png")]);
  await untilHeld();
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await releaseHeld();
  const image = page.locator(".ProseMirror .milkdown-image-block img");
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(page.locator(".milkdown-image-block.md-image-missing")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\n$/);
  const link = /\]\(([^)]+)\)/.exec(await readFile(saved, "utf8"))![1]!;
  expect(await readFile(path.join(path.dirname(saved), link))).toEqual(await readFile(path.join(directory, "pixel.png")));
});

/** A 16 by 16 PNG, which the system clipboard takes as an image. */
const clipboardPng = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4ISdHEmIY1TCqYfhqAADkYgQQ60fIxgAAAABJRU5ErkJggg==";
/** A 24 by 24 PNG, told apart from `clipboardPng` by its width. */
const widerPng = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR42mNQaLhAFcQwatCoQaMGjRo0atCoQQNvEABwyDwuqHdCUQAAAABJRU5ErkJggg==";

/** Put a PNG, `clipboardPng` unless `png` gives another in base64, alone on
 *  the system clipboard, as a screenshot tool does, and paste it at the end
 *  of `line`. */
async function pasteImageAtEnd(line: Locator, png = clipboardPng): Promise<void> {
  await app!.evaluate(({ clipboard, ClipboardItem }, image) =>
    clipboard.write([new ClipboardItem({ "image/png": new Blob([Buffer.from(image, "base64")], { type: "image/png" }) })]),
  png);
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+v");
}

/** The width of each PNG a saved document shows, embedded or in its
 *  attachments folder, in the order the document shows them. */
async function imageWidths(file: string): Promise<number[]> {
  const sources = [...(await readFile(file, "utf8")).matchAll(/!\[\]\(([^)]+)\)/g)].map((match) => match[1]!);
  const images = await Promise.all(sources.map((src) => {
    const embedded = /^data:image\/png;base64,(.+)$/.exec(src);
    return embedded ? Buffer.from(embedded[1]!, "base64") : readFile(path.join(path.dirname(file), src));
  }));
  return images.map((image) => image.readUInt32BE(16));
}

/** Whether every image `images` matches has loaded. */
function allLoaded(images: Locator): Promise<boolean> {
  return images.evaluateAll((elements) =>
    elements.length > 0 && elements.every((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0));
}

test("an image pasted into a document whose Save As ends after the image is written is written again beside it there", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  await holdCommand("write_attachment");
  await pasteImageAtEnd(page.locator(".ProseMirror p", { hasText: "First line." }));
  await untilHeld();
  // The user starts Save As while the image is written, and is still in its
  // dialog when the write ends.
  const answerSave = await holdSaveDialog(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "saveAsked") === true)).toBe(true);
  await releaseHeld();
  await untilHeldAnswered();
  await answerSave();
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await expect.poll(() => allLoaded(page.locator(".ProseMirror .milkdown-image-block img"))).toBe(true);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\n$/);
  // The link leads to a copy beside the document where it is saved, and the
  // copy written beside its old place stays.
  const link = /\]\(([^)]+)\)/.exec(await readFile(saved, "utf8"))![1]!;
  expect(await exists(path.join(path.dirname(saved), link))).toBe(true);
  expect(await readdir(path.join(path.dirname(original), "attachments"))).toHaveLength(1);
});

test("an image pasted into a document while a Save As of it is written goes beside it where it is saved", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  // The Save As is written slowly, as to a network share.
  await holdCommand("write_file");
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await untilHeld();
  await pasteImageAtEnd(page.locator(".ProseMirror p", { hasText: "First line." }));
  // Give the paste the time it would take to write the image beside the old place.
  await page.waitForTimeout(500);
  expect(await exists(path.join(path.dirname(original), "attachments"))).toBe(false);
  await releaseHeld();
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await expect.poll(() => allLoaded(page.locator(".ProseMirror .milkdown-image-block img"))).toBe(true);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\n$/);
  const link = /\]\(([^)]+)\)/.exec(await readFile(saved, "utf8"))![1]!;
  expect(await exists(path.join(path.dirname(saved), link))).toBe(true);
  expect(await exists(path.join(path.dirname(original), "attachments"))).toBe(false);
});

test("an image pasted into a document that is closed while a Save As of it is written asks first, and saves no other document", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "original", "notes.md");
  const other = path.join(directory, "original", "other.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First line.\n\nSecond line.\n");
  await writeFile(other, "Other line.\n");
  await launch(original);
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  // Another document has an edit that is not saved, which Save would write.
  await chooseOpen(other);
  await typeAtEnd(page.locator(".editor-pane:not([hidden]) .ProseMirror p", { hasText: "Other line." }), " Not saved.");
  await tab(/notes\.md/).click();
  const first = page.locator(".editor-pane:not([hidden]) .ProseMirror p", { hasText: "First line." });
  await expect(first).toBeVisible();
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  // Record the unsaved-changes prompts and answer Discard.
  await app!.evaluate(({ dialog }) => {
    const prompts: string[] = [];
    Object.assign(globalThis, { prompts });
    dialog.showMessageBox = async (...args: unknown[]) => {
      prompts.push(String((args.at(-1) as { message?: unknown }).message));
      return { response: 1, checkboxChecked: false };
    };
  });
  // The Save As is written slowly, as to a network share.
  await holdCommand("write_file");
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await untilHeld();
  await pasteImageAtEnd(first);
  // The image waits for the Save As, and its document counts as unsaved.
  await expect(tab(/notes\.md/).locator(".tab-dot")).toBeVisible();
  // On Linux a middle click also pastes the selection into the document.
  await tab(/notes\.md/).locator(".tab-close").click();
  await expect(tab(/notes\.md/)).toHaveCount(0);
  expect(await app!.evaluate(() => (globalThis as { prompts?: string[] }).prompts ?? [])).toEqual([
    '"notes.md" has unsaved changes. Discard them?',
  ]);
  // A save of an untitled document would ask where to save it.
  await app!.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => {
      Reflect.set(globalThis, "saveAskedAfterClose", true);
      return { canceled: true, filePath: "" };
    };
  });
  await releaseHeld();
  await expect.poll(() => exists(saved)).toBe(true);
  // Give the image the time it would take to be written and saved for.
  await page.waitForTimeout(1000);
  expect(await readFile(other, "utf8")).toBe("Other line.\n");
  await expect(tab(/other\.md/).locator(".tab-dot")).toBeVisible();
  expect(await app!.evaluate(() => Reflect.get(globalThis, "saveAskedAfterClose") === true)).toBe(false);
  expect(await exists(path.join(path.dirname(original), "attachments"))).toBe(false);
  expect(await exists(path.join(path.dirname(saved), "attachments"))).toBe(false);
  expect(errors).toEqual([]);
});

for (const [when, held] of [
  ["while a Save As of its document is written", "write_file"],
  ["while it is written", "write_attachment"],
] as const) {
  test(`an image pasted ${when} goes in where it was pasted after a switch to the Markdown view, and typing there afterwards is saved`, async () => {
    await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
    const original = path.join(directory, "notes.md");
    const saved = held === "write_file" ? path.join(directory, "saved.md") : original;
    await writeFile(original, "First line.\n\nSecond line.\n");
    await launch(original);
    const first = page.locator(".ProseMirror p", { hasText: "First line." });
    await expect(first).toBeVisible();
    // Written slowly, as to a network share.
    await holdCommand(held);
    if (held === "write_file") {
      await chooseSave(saved);
      await page.keyboard.press("ControlOrMeta+Shift+s");
      await untilHeld();
    }
    await pasteImageAtEnd(first);
    if (held === "write_attachment") await untilHeld();
    await expect(page.getByRole("tab", { name: /notes\.md/ }).locator(".tab-dot")).toBeVisible();
    await page.getByRole("radio", { name: "Markdown", exact: true }).click();
    const source = page.locator(".cm-content");
    await source.click();
    await page.keyboard.press("ControlOrMeta+End");
    await releaseHeld();
    // The hidden document view takes the image where it was pasted, and the
    // Markdown view makes the matching change. Before, the document view took
    // it alone and left this view behind the document's text, which dropped
    // the typing below from the save.
    await expect(source).toContainText("![](attachments/img-");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n\nThird line.");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(saved, "utf8")).toMatch(/^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\n\n\nThird line\.$/);
    const link = /\]\(([^)]+)\)/.exec(await readFile(saved, "utf8"))![1]!;
    expect(await exists(path.join(path.dirname(saved), link))).toBe(true);
  });
}

for (const [start, opening] of [
  ["a heading", "# Title\n\n"],
  ["frontmatter", "---\ntitle: Notes\n---\n\n"],
] as const) {
  test(`an image pasted into a document that starts with ${start} keeps its place after a switch to the Markdown view`, async () => {
    await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
    const file = path.join(directory, "notes.md");
    await writeFile(file, `${opening}First line.\n\nSecond line.\n`);
    await launch(file);
    const first = page.locator(".ProseMirror p", { hasText: "First line." });
    await expect(first).toBeVisible();
    await holdCommand("write_attachment");
    await pasteImageAtEnd(first);
    await untilHeld();
    // The user switches without a click in the Markdown view, so its caret is
    // still at the start of the text.
    await page.getByRole("radio", { name: "Markdown", exact: true }).click();
    const source = page.locator(".cm-content");
    await expect(source).toBeVisible();
    await releaseHeld();
    await expect(source).toContainText("![](attachments/img-");
    await page.keyboard.press("ControlOrMeta+s");
    // At the Markdown view's caret, the image would have joined the heading's
    // line or come before the frontmatter, and turned either into text.
    await expect.poll(() => readFile(file, "utf8")).toMatch(/img-/);
    expect((await readFile(file, "utf8")).replace(/attachments\/img-[^)]+\.png/, "IMG")).toBe(`${opening}First line.\n\n![](IMG)\n\nSecond line.\n`);
  });
}

test("the images of a drop on the document all keep their place after a switch to the Markdown view while they are read", async () => {
  const file = path.join(directory, "notes.md");
  await writeFile(file, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n");
  await launch(file);
  const second = page.locator(".ProseMirror p", { hasText: "Second paragraph." });
  await expect(second).toBeVisible();
  await holdCommand("read_image_bytes");
  await dropBelow(second, [await pngFile("narrow.png", clipboardPng), await pngFile("wide.png", widerPng)]);
  await untilHeld();
  // The user switches without a click in the Markdown view, so its caret is
  // still at the start of the text.
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".cm-content");
  await expect(source).toBeVisible();
  await releaseHeld();
  await expect.poll(async () => (await source.textContent())?.match(/!\[\]\(data:/g)?.length ?? 0).toBe(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/data:/);
  // Both go in after the second paragraph. If the first image's own source
  // change left the document view behind the text, the second would go in
  // at the Markdown view's caret, after the first paragraph.
  expect((await readFile(file, "utf8")).replace(/data:image\/png;base64,[^)]+/g, "IMG")).toBe(
    "First paragraph.\n\nSecond paragraph.\n\n![](IMG)\n\n![](IMG)\n\nThird paragraph.\n",
  );
  expect(await imageWidths(file)).toEqual([16, 24]);
});

for (const kind of ["pasted", "dropped"] as const) {
  for (const markdownView of [false, true]) {
    test(`an image ${kind} where an earlier one still waits to be written goes in after it${markdownView ? ", also after a switch to the Markdown view" : ""}`, async () => {
      await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
      const file = path.join(directory, "notes.md");
      await writeFile(file, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n");
      await launch(file);
      const second = page.locator(".ProseMirror p", { hasText: "Second paragraph." });
      await expect(second).toBeVisible();
      // The first image is written slowly, as to a network share, and the
      // second at once.
      await holdCommand("write_attachment", { first: 1 });
      const put = async (png: string, name: string): Promise<void> => {
        if (kind === "pasted") await pasteImageAtEnd(second, png);
        else await dropBelow(second, [await pngFile(name, png)]);
      };
      await put(clipboardPng, "narrow.png");
      await untilHeld();
      await put(widerPng, "wide.png");
      // Give the second image the time it would take to be written and go in.
      // It waits for the first, which would otherwise go in after it, and is
      // written only once the first is in.
      await page.waitForTimeout(1000);
      await expect(page.locator(".ProseMirror .milkdown-image-block")).toHaveCount(0);
      expect(await passedAnswered()).toBe(0);
      const source = page.locator(".cm-content");
      if (markdownView) {
        await page.getByRole("radio", { name: "Markdown", exact: true }).click();
        await expect(source).toBeVisible();
      }
      await releaseHeld();
      if (markdownView) await expect.poll(async () => (await source.textContent())?.match(/!\[\]\(attachments\//g)?.length ?? 0).toBe(2);
      else await expect(page.locator(".ProseMirror .milkdown-image-block")).toHaveCount(2);
      await page.keyboard.press("ControlOrMeta+s");
      await expect.poll(() => readFile(file, "utf8")).toMatch(/img-/);
      expect((await readFile(file, "utf8")).replace(/attachments\/img-[^)]+\.png/g, "IMG")).toBe(
        "First paragraph.\n\nSecond paragraph.\n\n![](IMG)\n\n![](IMG)\n\nThird paragraph.\n",
      );
      expect(await imageWidths(file)).toEqual([16, 24]);
    });
  }
}

test("images pasted into a list item before a switch to the Markdown view both go into the item", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const file = path.join(directory, "notes.md");
  await writeFile(file, "- one\n- two\n\nAfter.\n");
  await launch(file);
  const item = page.locator(".ProseMirror li p").filter({ hasText: /^two$/ });
  await expect(item).toBeVisible();
  await holdCommand("write_attachment");
  await pasteImageAtEnd(item);
  await untilHeld();
  await pasteImageAtEnd(item, widerPng);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".cm-content");
  await expect(source).toBeVisible();
  await releaseHeld();
  await expect.poll(async () => (await source.textContent())?.match(/!\[\]\(attachments\//g)?.length ?? 0).toBe(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/img-.*img-/s);
  // The mirror of the first image's change must not rewrite the item, which
  // would put the second image after the list.
  expect((await readFile(file, "utf8")).replace(/attachments\/img-[^)]+\.png/g, "IMG")).toBe(
    "- one\n- two\n\n  ![](IMG)\n\n  ![](IMG)\n\nAfter.\n",
  );
  expect(await imageWidths(file)).toEqual([16, 24]);
});

test("images pasted before a switch to the Markdown view that both go in at its caret keep their paste order", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const file = path.join(directory, "notes.md");
  await writeFile(file, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n");
  await launch(file);
  const second = page.locator(".ProseMirror p", { hasText: "Second paragraph." });
  await expect(second).toBeVisible();
  await holdCommand("write_attachment");
  await pasteImageAtEnd(second);
  await untilHeld();
  await pasteImageAtEnd(second, widerPng);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".cm-content");
  await expect(source).toBeVisible();
  // Typing in the Markdown view leaves the document view behind, so both
  // images lose their place and go in at the caret, which stays before them.
  await page.locator(".cm-line", { hasText: "First paragraph." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await releaseHeld();
  await expect.poll(async () => (await source.textContent())?.match(/!\[\]\(attachments\//g)?.length ?? 0).toBe(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/img-.*img-/s);
  expect((await readFile(file, "utf8")).replace(/attachments\/img-[^)]+\.png/g, "IMG")).toBe(
    "First paragraph.X\n\n![](IMG)\n\n![](IMG)\n\nSecond paragraph.\n\nThird paragraph.\n",
  );
  expect(await imageWidths(file)).toEqual([16, 24]);
});

test("images dropped one after another away from the text go in at the caret in drop order while the user clicks there again", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const file = path.join(directory, "notes.md");
  await writeFile(file, "First paragraph.\n\nSecond paragraph.\n");
  await launch(file);
  const first = page.locator(".ProseMirror p", { hasText: "First paragraph." });
  await expect(first).toBeVisible();
  const toolbar = page.getByRole("button", { name: "Save", exact: true });
  await holdCommand("write_attachment");
  await first.click();
  await page.keyboard.press("End");
  await dropFiles(toolbar, [await pngFile("narrow.png", clipboardPng)]);
  await untilHeld();
  // The click leaves the caret before the first image once it is in.
  await first.click();
  await page.keyboard.press("End");
  await dropFiles(toolbar, [await pngFile("wide.png", widerPng)]);
  await releaseHeld();
  await expect(page.locator(".ProseMirror .milkdown-image-block")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/img-.*img-/s);
  expect((await readFile(file, "utf8")).replace(/attachments\/img-[^)]+\.png/g, "IMG")).toBe(
    "First paragraph.\n\n![](IMG)\n\n![](IMG)\n\nSecond paragraph.\n",
  );
  expect(await imageWidths(file)).toEqual([16, 24]);
});

test("an image pasted while an earlier one is written goes beside the document where a Save As meanwhile puts it", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "original", "notes.md");
  const saved = path.join(directory, "moved", "notes.md");
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(saved));
  await writeFile(original, "First paragraph.\n\nSecond paragraph.\n");
  await launch(original);
  const first = page.locator(".ProseMirror p", { hasText: "First paragraph." });
  await expect(first).toBeVisible();
  await holdCommand("write_attachment", { first: 1 });
  await pasteImageAtEnd(first);
  await untilHeld();
  await pasteImageAtEnd(first, widerPng);
  await page.waitForTimeout(500);
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("title", saved);
  await releaseHeld();
  await expect(page.locator(".ProseMirror .milkdown-image-block")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/img-.*img-/s);
  // Both links lead from the new folder. The second image would otherwise
  // be written beside the old one while it waited for the first.
  const links = [...(await readFile(saved, "utf8")).matchAll(/!\[\]\(([^)]+)\)/g)].map((match) => match[1]!);
  expect(await Promise.all(links.map((link) => exists(path.join(path.dirname(saved), link))))).toEqual([true, true]);
  expect(await imageWidths(saved)).toEqual([16, 24]);
  await expect(page.locator(".milkdown-image-block.md-image-missing")).toHaveCount(0);
});

test("an image chosen in an image block's upload input while it is written goes into the Markdown view shown by then, and typing there afterwards is saved", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const file = path.join(directory, "notes.md");
  await writeFile(file, "First line.\n\n![]()\n\nSecond line.\n");
  await launch(file);
  const upload = page.locator(".milkdown-image-block input[type=file]");
  await expect(upload).toHaveCount(1);
  await holdCommand("write_attachment");
  await upload.setInputFiles(await pngFile("pixel.png"));
  await untilHeld();
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".cm-content");
  await source.click();
  await page.keyboard.press("ControlOrMeta+End");
  await releaseHeld();
  // The hidden document view takes the image, and the Markdown view takes the
  // document's text from it. Otherwise the Markdown view would lag the text,
  // and the typing below would be left out of the save.
  await expect(source).toContainText("![](attachments/img-");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed after upload.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toContain("Typed after upload.");
  expect(await readFile(file, "utf8")).toMatch(/^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\nTyped after upload\.$/);
});

test("an image pasted while a Save As of its document is written goes in after an edit in the Markdown view rebuilt the document view", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const original = path.join(directory, "notes.md");
  const saved = path.join(directory, "saved.md");
  await writeFile(original, "First line.\n\nSecond line.\n");
  await launch(original);
  const first = page.locator(".ProseMirror p", { hasText: "First line." });
  await expect(first).toBeVisible();
  await holdCommand("write_file");
  await chooseSave(saved);
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await untilHeld();
  await pasteImageAtEnd(first);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nThird line.\n");
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p", { hasText: "Third line." })).toBeVisible();
  await releaseHeld();
  // The document view that took the paste was rebuilt for the edit, and the
  // image goes in at the new one's caret.
  await expect(page.locator(".editor-pane:not([hidden]) .milkdown-image-block img")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/!\[\]\(attachments\/img-[^)]+\.png\)/);
  const text = await readFile(saved, "utf8");
  expect(text.replace(/!\[\]\(attachments\/img-[^)]+\.png\)\n\n/, "")).toBe("First line.\n\nSecond line.\n\nThird line.\n");
  const link = /\]\(([^)]+)\)/.exec(text)![1]!;
  expect(await exists(path.join(path.dirname(saved), link))).toBe(true);
});

test("an image pasted into a document whose editor is dropped from memory while the image is written goes in once the document is shown again", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\nmaxRetainedTabEditors = 1\n");
  const original = path.join(directory, "notes.md");
  const other = path.join(directory, "other.md");
  await writeFile(original, "First line.\n\nSecond line.\n");
  await writeFile(other, "Other line.\n");
  await launch(original);
  await holdCommand("write_attachment");
  await pasteImageAtEnd(page.locator(".ProseMirror p", { hasText: "First line." }));
  await untilHeld();
  await chooseOpen(other);
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p", { hasText: "Other line." })).toBeVisible();
  // Only the tab in front keeps its editor.
  await expect(page.locator(".ProseMirror p", { hasText: "First line." })).toHaveCount(0);
  await releaseHeld();
  await untilHeldAnswered();
  // The image waits for its document, which shows as unsaved meanwhile.
  await expect(page.getByRole("tab", { name: /notes\.md/ }).locator(".tab-dot")).toBeVisible();
  await page.getByRole("tab", { name: /notes\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .milkdown-image-block img")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(original, "utf8")).toMatch(/!\[\]\(attachments\/img-[^)]+\.png\)/);
  const text = await readFile(original, "utf8");
  expect(text.replace(/!\[\]\(attachments\/img-[^)]+\.png\)\n\n/, "")).toBe("First line.\n\nSecond line.\n");
  expect(await readFile(other, "utf8")).toBe("Other line.\n");
});

test("an image pasted into an untitled document whose save the user cancels puts nothing in", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const other = path.join(directory, "other.md");
  await writeFile(other, "Other line.\n");
  await launch(other);
  await expect(page.locator(".ProseMirror p")).toHaveText("Other line.");
  const line = await newDocumentLine();
  await line.click();
  await page.keyboard.type("First line.");
  // The image needs a folder beside the document, so it asks where to save.
  await app!.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => {
      Reflect.set(globalThis, "saveAsked", true);
      return { canceled: true, filePath: "" };
    };
  });
  await pasteImageAtEnd(line);
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "saveAsked") === true)).toBe(true);
  // Give the paste the time it would take to put an image in.
  await page.waitForTimeout(500);
  // Crepe's upload plugin put in an image without a src, which showed its
  // upload input and was saved as ![]().
  await expect(page.locator(".editor-pane:not([hidden]) .milkdown-image-block")).toHaveCount(0);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("First line.");
  await expect(page.locator(".cm-content")).not.toContainText("![");
});

test("an image pasted or dropped as a file starts at its own URL, with no failed load or missing-image flash", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const file = path.join(directory, "inserted-images.md");
  await writeFile(file, "First line.\n\nSecond line.\n");
  await launch(file);
  // The observer below needs the document's editor.
  await expect(page.locator(".ProseMirror p", { hasText: "First line." })).toBeVisible();
  const problems: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  page.on("requestfailed", (request) => problems.push(`${request.url()} ${request.failure()?.errorText}`));
  // Answer each question about an image's URL 300 ms late, as a busy machine
  // or a slow share might. Electron keeps the handlers of ipcMain.handle in
  // `_invokeHandlers`, and a handler on the window's own `ipc` runs in their place.
  await app!.evaluate(({ BrowserWindow, ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const imageUrl = (Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler>).get("md-easy:image-url")!;
    BrowserWindow.getAllWindows()[0]!.webContents.ipc.handle("md-easy:image-url", async (event, ...args) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return imageUrl(event, ...args);
    });
  });
  // Record every src an image in the document takes, and whether one ever
  // shows as missing.
  await page.evaluate(() => {
    const root = document.querySelector(".milkdown .ProseMirror")!;
    const seen = { sources: [] as string[], missing: false };
    const note = (src: string | null): void => {
      if (src && !seen.sources.includes(src)) seen.sources.push(src);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof HTMLImageElement) note(record.target.getAttribute("src"));
        for (const added of record.addedNodes) {
          if (added instanceof Element) [added, ...added.querySelectorAll("img")].forEach((element) => element instanceof HTMLImageElement && note(element.getAttribute("src")));
        }
      }
      if (root.querySelector(".md-image-missing")) seen.missing = true;
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "class"] });
    Reflect.set(window, "imageHistory", seen);
  });
  const images = page.locator(".ProseMirror .milkdown-image-block img");
  await pasteImageAtEnd(page.locator(".ProseMirror p", { hasText: "First line." }));
  await expect(images).toHaveCount(1);
  await expect.poll(() => allLoaded(images)).toBe(true);
  await dropBelow(page.locator(".ProseMirror p", { hasText: "Second line." }), [await pngFile("pixel.png")]);
  await expect(images).toHaveCount(2);
  await expect.poll(() => allLoaded(images)).toBe(true);
  const history = await page.evaluate(() => Reflect.get(window, "imageHistory") as { sources: string[]; missing: boolean });
  // A raw path would be looked up next to md-easy's own page and fail there.
  expect(history.sources).toHaveLength(2);
  expect(history.sources.every((src) => src.startsWith("md-easy-file:"))).toBe(true);
  expect(history.missing).toBe(false);
  expect(problems).toEqual([]);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(
    /^First line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n\nSecond line\.\n\n!\[\]\(attachments\/img-[^)]+\.png\)\n$/,
  );
});

test("a file dropped on the split's document pane while the Markdown pane has focus goes in at the drop point and keeps the source as written", async () => {
  // The document view would write this heading and these bullets another way.
  const text = "First line.\n\nSecond line.\n\nTitle\n=====\n\n* Alpha\n* Beta\n";
  const { file } = await openSplit("drop-on-document-pane.md", text);
  const markdownLine = page.locator(".editor-pane-raw .cm-line", { hasText: "Second line." });
  await markdownLine.click();
  await page.keyboard.press("End");
  await dropBelow(page.locator(".editor-pane-wysiwyg .ProseMirror p", { hasText: "First line." }), [await csvFile("notes.csv")]);
  const link = "[notes.csv](attachments/notes.csv)";
  await expect(page.locator(".editor-pane-wysiwyg .ProseMirror p").nth(1)).toHaveText(/notes\.csv/);
  await expect(page.locator(".editor-pane-raw .cm-line", { hasText: "notes.csv" })).toHaveText(link);
  // Focus and the caret stay in the Markdown pane.
  await page.keyboard.type(" Typed.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    text.replace("First line.\n", `First line.\n\n${link}\n`).replace("Second line.", "Second line. Typed."),
  );
});

test("a file dropped while typing in the split's Markdown pane lands at the caret and keeps the rest as written", async () => {
  // The document view would write this heading and these bullets another way.
  const text = "Title\n=====\n\n* Alpha\n* Beta\n\nFirst line.\n\n* Gamma\n";
  const { file } = await openSplit("drop-while-typing.md", text);
  const markdownLine = page.locator(".editor-pane-raw .cm-line", { hasText: "First line." });
  const attachment = path.join(directory, "notes.csv");
  const link = "[notes.csv](attachments/notes.csv)";
  await writeFile(attachment, "a,b\n");
  await markdownLine.click();
  await page.keyboard.press("End");
  // The drop lands between keystrokes in the Markdown pane.
  const typing = page.keyboard.type(" Typed during the drop.", { delay: 40 });
  await expect(markdownLine).toContainText("First line. Ty");
  await dropFiles(markdownLine, [attachment]);
  await typing;
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toContain(link);
  const saved = await readFile(file, "utf8");
  expect(saved.replace(link, "")).toBe(text.replace("First line.", "First line. Typed during the drop."));
});

test("a formula typed last in the document pane is kept by the split's Markdown pane and a view switch", async () => {
  const { file, documentLine, markdownLine } = await openSplit("formula-last.md");
  await typeAtEnd(documentLine, " a $x$");
  // Once typing pauses the Markdown pane shows the formula as Save would
  // write it, while the closing `$` still waits for the next character.
  await expect(markdownLine).toHaveText("First line. a $x$");
  await expect(page.locator('.editor-pane-wysiwyg [data-type="math_inline"]')).toHaveCount(0);
  await typeAtEnd(markdownLine, " raw");
  await expect(page.locator('.editor-pane-wysiwyg [data-type="math_inline"]')).toHaveCount(1);
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await typeAtEnd(documentLine, " b $y$");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".editor-pane-raw .cm-line").first()).toHaveText("First line. a $x$ raw b $y$");
  await page.getByRole("radio", { name: "Document", exact: true }).click();
  await expect(page.locator('.milkdown [data-type="math_inline"]')).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line. a $x$ raw b $y$\n");
});

/** A PNG to drop, one pixel unless `png` gives another in base64, written as
 *  `name`, returning its path. */
async function pngFile(name: string, png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, Buffer.from(png, "base64"));
  return file;
}

/** Drop files a pixel above the bottom edge of `line`, where Crepe's drop
 *  indicator marks the edge below it. */
async function dropBelow(line: Locator, files: string[]): Promise<void> {
  const box = (await line.boundingBox())!;
  await dropFiles(line, files, { x: box.width / 2, y: box.height - 2 });
}

/** Open a new document with the tab strip's New document button and return
 *  its empty line once its pane is in front. Call it once the document the
 *  app launched with is shown. The button opens no menu, which that document
 *  closes when it takes focus as startup ends. The document shown before
 *  stays in front until the new document's editor is built. A click on a
 *  line of the shown pane could take that document's line and keep waiting
 *  on it after it is hidden, because Playwright looks a locator up again only
 *  for an element that left the page. */
async function newDocumentLine(): Promise<Locator> {
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const line = page.locator(".editor-pane:not([hidden]) .ProseMirror p");
  await expect(line).toHaveText([""]);
  return line;
}

test("typing right after a file dropped on the document goes after it and keeps it", async () => {
  const file = path.join(directory, "type-after-drop.md");
  await writeFile(file, "First line.\n\nSecond line.\n\nThird line.\n");
  await launch(file);
  const images = page.locator(".ProseMirror .milkdown-image-block");
  // An image between lines, then typing.
  await dropBelow(page.locator(".ProseMirror p", { hasText: "Second line." }), [await pngFile("middle.png")]);
  await expect(images).toHaveCount(1);
  await page.keyboard.type("x");
  // A link, then typing, which stays out of the link.
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [await csvFile("notes.csv")]);
  await expect(page.locator(".ProseMirror p").nth(1)).toHaveText(/notes\.csv/);
  await page.keyboard.type(" typed");
  // An image below the text, which ends the document, then typing.
  const pageBox = (await page.locator(".editor-column").boundingBox())!;
  await dropFiles(page.locator(".editor-column"), [await pngFile("last.png")], { x: pageBox.width / 2, y: pageBox.height - 40 });
  await expect(images).toHaveCount(2);
  await page.keyboard.type("y");
  await page.keyboard.press("ControlOrMeta+s");
  const image = /!\[\]\(data:image\/png;base64,[^)]+\)/.source;
  await expect.poll(() => readFile(file, "utf8")).toMatch(new RegExp(
    `^First line\\.\\n\\n\\[notes\\.csv\\]\\(attachments/notes\\.csv\\) typed\\n\\nSecond line\\.\\n\\n${image}\\n\\nxThird line\\.\\n\\n${image}\\n\\ny\\n$`,
  ));
});

test("typing right after a link dropped as a list item stays out of the link", async () => {
  const file = path.join(directory, "type-after-list-drop.md");
  await writeFile(file, "Intro.\n\n- Item 1\n- Item 2\n\n1. One\n2. Two\n");
  await launch(file);
  await dropBelow(page.locator(".ProseMirror li p", { hasText: "Item 1" }), [await csvFile("a.csv")]);
  await expect(page.locator(".ProseMirror li p").nth(1)).toHaveText(/a\.csv/);
  await page.keyboard.type(" typed");
  await dropBelow(page.locator(".ProseMirror li p", { hasText: "One" }), [await csvFile("b.csv")]);
  await expect(page.locator(".ProseMirror ol li p").nth(1)).toHaveText(/b\.csv/);
  await page.keyboard.type(" typed");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "Intro.\n\n- Item 1\n- [a.csv](attachments/a.csv) typed\n- Item 2\n\n1. One\n2. [b.csv](attachments/b.csv) typed\n3. Two\n",
  );
});

test("typing right after a file dropped before a link to the same file stays out of the link", async () => {
  const file = path.join(directory, "drop-before-same-link.md");
  // The attachments are missing, so a dropped file takes the name of one, and
  // its link the same target.
  const lines = [
    "a[report.csv](attachments/report.csv)b",
    "# c[notes.csv](attachments/notes.csv)d",
    "e[data.csv](attachments/data.csv)f",
    "# g[list.csv](attachments/list.csv)h",
    "i[log.csv](attachments/log.csv)j",
  ];
  await writeFile(file, `${lines.join("\n\n")}\n`);
  await launch(file);
  await expect(page.locator(".ProseMirror a")).toHaveCount(lines.length);
  const toolbar = page.getByRole("button", { name: "Save", exact: true });
  // Dropped away from the text, a file goes in at the caret, and ProseMirror
  // joins its link with the one after it. Milkdown changes a heading's id
  // after each edit of it, and Backspace or Delete gives the caret's next
  // text the deleted character's marks.
  const steps: [string, () => Promise<void>, string][] = [
    ["report.csv", async () => {}, "x"],
    ["notes.csv", async () => {}, "y"],
    ["data.csv", () => page.keyboard.press("Backspace"), "z"],
    ["list.csv", () => page.keyboard.press("Delete"), "w"],
    ["log.csv", async () => {
      // A pause makes the letter an undo step of its own, apart from the drop.
      await page.waitForTimeout(700);
      await page.keyboard.type("v");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.locator(".ProseMirror a", { hasText: "log.csvlog.csv" })).toHaveCount(1);
    }, "u"],
  ];
  for (const [name, edit, typed] of steps) {
    await clickOn(name, 0, 0.25);
    await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await dropFiles(toolbar, [await csvFile(name)]);
    await expect(page.locator(".ProseMirror a", { hasText: name + name })).toHaveCount(1);
    await edit();
    await page.keyboard.type(typed);
  }
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "a[report.csv](attachments/report.csv)x[report.csv](attachments/report.csv)b",
    "# c[notes.csv](attachments/notes.csv)y[notes.csv](attachments/notes.csv)d",
    "e[data.cs](attachments/data.csv)z[data.csv](attachments/data.csv)f",
    "# g[list.csv](attachments/list.csv)w[ist.csv](attachments/list.csv)h",
    "i[log.csv](attachments/log.csv)u[log.csv](attachments/log.csv)j",
  ].join("\n\n") + "\n");
});

test("a file dropped on a collapsed base64 image in the Markdown view goes in after the image", async () => {
  const file = path.join(directory, "drop-on-image-data.md");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=".repeat(4);
  const image = `![pic](data:image/png;base64,${data})`;
  await writeFile(file, `First line.\n\n${image}\n\nLast line.\n`);
  await launch(file);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const chip = page.locator(".cm-base64-collapsed");
  // Near the chip's start, where the drop finds the start of the data.
  await dropFiles(chip, [await csvFile("a.csv")], { x: 2, y: 5 });
  const link = "[a.csv](attachments/a.csv)";
  await expect(page.locator(".cm-line", { hasText: "a.csv" })).toContainText(link);
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(`First line.\n\n${image}${link}!\n\nLast line.\n`);
});

test("a file dropped while the find card's match is in the frontmatter table leaves the table alone", async () => {
  const file = path.join(directory, "drop-find-frontmatter.md");
  await writeFile(file, "---\ntitle: Review notes\n---\n\nFirst line.\n\nSecond line.\n");
  await launch(file);
  await expect(page.locator(".frontmatter-table")).toBeVisible();
  await page.locator(".ProseMirror p", { hasText: "Second line." }).click();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in document" }).fill("Review");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await dropBelow(page.locator(".ProseMirror p", { hasText: "First line." }), [await csvFile("notes.csv")]);
  await expect(page.locator(".ProseMirror p").nth(1)).toHaveText(/notes\.csv/);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Caption");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "---\ntitle: Review notes\n---\n\nFirst line.\n\n[notes.csv](attachments/notes.csv)\n\nCaption\n\nSecond line.\n",
  );
});

test("typing in the split's Markdown pane across a drop on the document pane stays in the Markdown pane as typed", async () => {
  // The document view would write this heading and these bullets another way.
  const text = "First line.\n\nSecond line.\n\nTitle\n=====\n\n* Gamma\n";
  const { file } = await openSplit("type-across-drop.md", text);
  const markdownLine = page.locator(".editor-pane-raw .cm-line", { hasText: "Second line." });
  await markdownLine.click();
  await page.keyboard.press("End");
  // Ends in a space, which the document view would not keep at the end of a line.
  const typing = page.keyboard.type(" Typed during the drop ", { delay: 40 });
  await expect(markdownLine).toContainText("Second line. Ty");
  await dropBelow(page.locator(".editor-pane-wysiwyg .ProseMirror p", { hasText: "First line." }), [await csvFile("notes.csv")]);
  await typing;
  const link = "[notes.csv](attachments/notes.csv)";
  await expect(page.locator(".editor-pane-raw .cm-line", { hasText: "notes.csv" })).toHaveText(link);
  // A pause, then more typing, which goes on where it was.
  await page.waitForTimeout(1500);
  await page.keyboard.type("and after.");
  await expect(markdownLine).toHaveText("Second line. Typed during the drop and after.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    text.replace("First line.\n", `First line.\n\n${link}\n`).replace("Second line.", "Second line. Typed during the drop and after."),
  );
});

test("a file dropped on the find card goes in after the current match instead of over it", async () => {
  const file = path.join(directory, "drop-on-find.md");
  await writeFile(file, "First line.\n\nSecond line.\n");
  await launch(file);
  await page.locator(".ProseMirror p", { hasText: "Second line." }).click();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in document" });
  await find.fill("line.");
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await dropFiles(find, [await csvFile("notes.csv")]);
  await expect(page.locator(".ProseMirror p").nth(1)).toHaveText(/notes\.csv/);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\n\n[notes.csv](attachments/notes.csv)\n\nSecond line.\n");
});

test("a file dropped on the split's Markdown pane goes in there, where it was dropped, while the document pane has focus", async () => {
  const { file, documentLine, markdownLine } = await openSplit("drop-on-markdown-pane.md", "First line.\n\nSecond line.\n");
  // The Markdown pane's caret at the end of its first line, then focus in the document pane.
  await markdownLine.click();
  await page.keyboard.press("End");
  await documentLine.click();
  // Past the end of the second line, where CodeMirror's drop cursor shows at its end.
  const secondLine = page.locator(".editor-pane-raw .cm-line", { hasText: "Second line." });
  await dropFiles(secondLine, [await csvFile("notes.csv")]);
  await expect(secondLine).toHaveText("Second line.[notes.csv](attachments/notes.csv)");
  // The Markdown pane takes focus, with the caret after the file.
  await page.keyboard.type(" Typed.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\n\nSecond line.[notes.csv](attachments/notes.csv) Typed.\n");
});

test("a file dropped on a document goes into it once it is in front again after another tab came to the front", async () => {
  const other = path.join(directory, "other.md");
  await writeFile(other, "Other line.\n");
  await launch(other);
  await expect(page.locator(".ProseMirror p")).toHaveText("Other line.");
  const line = await newDocumentLine();
  await line.click();
  await page.keyboard.type("Alpha line.");
  // The untitled document asks where to save before its attachments folder
  // exists. Hold that answer back until the other tab is in front.
  const saved = path.join(directory, "sub", "saved.md");
  await mkdir(path.dirname(saved));
  await app!.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => new Promise((resolve) => {
      Reflect.set(globalThis, "answerSave", () => resolve({ canceled: false, filePath }));
    });
  }, saved);
  await dropBelow(line, [await csvFile("notes.csv")]);
  await expect.poll(() => app!.evaluate(() => typeof Reflect.get(globalThis, "answerSave"))).toBe("function");
  await page.getByRole("tab", { name: /other\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p").first()).toHaveText("Other line.");
  await app!.evaluate(() => (Reflect.get(globalThis, "answerSave") as () => void)());
  await expect.poll(() => stat(path.join(directory, "sub", "attachments", "notes.csv")).then(() => true, () => false)).toBe(true);
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror")).toHaveText("Other line.");
  // The file waits for its document, which shows as unsaved meanwhile.
  await expect(page.getByRole("tab", { name: /saved\.md/ }).locator(".tab-dot")).toBeVisible();
  await page.getByRole("tab", { name: /saved\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror p").nth(1)).toHaveText(/notes\.csv/);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toBe("Alpha line.\n\n[notes.csv](attachments/notes.csv)\n");
  expect(await readFile(other, "utf8")).toBe("Other line.\n");
});

test("an image dropped on an untitled document asks where to save it once that document is in front again", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nembedImagesAsBase64 = false\n");
  const other = path.join(directory, "other.md");
  await writeFile(other, "Other line.\n");
  await launch(other);
  await expect(page.locator(".ProseMirror p")).toHaveText("Other line.");
  const line = await newDocumentLine();
  await line.click();
  await page.keyboard.type("Alpha line.");
  // Each image goes beside the document, which asks where to save it first.
  // Hold the answers back.
  await app!.evaluate(({ dialog }) => {
    const answers: Array<(path: string | null) => void> = [];
    Reflect.set(globalThis, "saveAnswers", answers);
    dialog.showSaveDialog = () => new Promise((resolve) => {
      answers.push((filePath) => resolve(filePath ? { canceled: false, filePath } : { canceled: true, filePath: "" }));
    });
  });
  const asked = () => app!.evaluate(() => (Reflect.get(globalThis, "saveAnswers") as unknown[]).length);
  const answer = (index: number, filePath: string | null) =>
    app!.evaluate((_electron, [at, chosen]) => (Reflect.get(globalThis, "saveAnswers") as Array<(path: string | null) => void>)[at]!(chosen), [index, filePath] as const);
  await dropBelow(line, [await pngFile("first.png"), await pngFile("second.png")]);
  await expect.poll(asked).toBe(1);
  // The other tab comes to the front before the first prompt is answered, so
  // the second image is read while its document is behind.
  await page.getByRole("tab", { name: /other\.md/ }).click();
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror")).toHaveText("Other line.");
  await answer(0, null);
  // No prompt over the other document.
  await page.waitForTimeout(1000);
  expect(await asked()).toBe(1);
  await page.getByRole("tab", { name: /Untitled/ }).click();
  await expect.poll(asked).toBe(2);
  const saved = path.join(directory, "saved.md");
  await answer(1, saved);
  await expect(page.locator(".editor-pane:not([hidden]) .ProseMirror img")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(saved, "utf8")).toMatch(/^Alpha line\.\n\n!\[\]\(attachments\/[^)]+\.png\)\n$/);
  expect(await readFile(other, "utf8")).toBe("Other line.\n");
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

/**
 * What keeps find's current match from being fully on its page and clear of
 * the find card, or "" when nothing does. The match is the current highlight
 * in the shown editor or in the frontmatter table, and its page is the editor
 * area, or the pane it is in when the panes scroll on their own.
 */
function currentMatchProblem(): Promise<string> {
  return page.evaluate(() => {
    const parts = [...document.querySelectorAll(".md-find-current")].filter((part) => part.getClientRects().length);
    const ranges = [...(CSS.highlights.get("md-find-current") ?? [])].filter((range) => range instanceof Range);
    const anchor = parts[0] ?? ranges[0]?.startContainer.parentElement;
    const boxes = [...parts, ...ranges].flatMap((part) => [...part.getClientRects()]);
    if (!anchor || !boxes.length) return "no current match";
    const match = {
      top: Math.min(...boxes.map((box) => box.top)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
      left: Math.min(...boxes.map((box) => box.left)),
      right: Math.max(...boxes.map((box) => box.right)),
    };
    const area = document.querySelector(".editor-area")!;
    const scroller = area.matches(".split, .markdown-only") ? anchor.closest(".editor-pane")! : area;
    const frame = scroller.getBoundingClientRect();
    const top = frame.top + scroller.clientTop;
    const left = frame.left + scroller.clientLeft;
    const visible = { top, bottom: top + scroller.clientHeight, left, right: left + scroller.clientWidth };
    const card = document.querySelector(".find-bar")!.getBoundingClientRect();
    const show = (box: typeof match) =>
      `${Math.round(box.top)}-${Math.round(box.bottom)} down, ${Math.round(box.left)}-${Math.round(box.right)} across`;
    const outside = match.top < visible.top - 0.5 || match.bottom > visible.bottom + 0.5 || match.left < visible.left - 0.5 || match.right > visible.right + 0.5;
    if (outside) return `the match at ${show(match)} is not inside its page at ${show(visible)}`;
    const covered = match.bottom > card.top + 0.5 && match.top < card.bottom - 0.5 && match.right > card.left + 0.5 && match.left < card.right - 0.5;
    if (covered) return `the match at ${show(match)} is under the card at ${show(card)}`;
    return "";
  });
}

/** How far the find card sits from the bottom and right of the editor area,
 *  which ends at the status bar, and the card's height. */
function cardInsets(): Promise<{ bottom: number; right: number; height: number }> {
  return page.evaluate(() => {
    const card = document.querySelector(".find-bar")!.getBoundingClientRect();
    const area = document.querySelector(".main-region")!.getBoundingClientRect();
    return { bottom: Math.round(area.bottom - card.bottom), right: Math.round(area.right - card.right), height: Math.round(card.height) };
  });
}

/** Wait until the page has painted twice, so find's scrolls in frame callbacks are done. */
function twoFrames(): Promise<unknown> {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** A long document whose last line ends in "needle", under the find card's
 *  columns. It has no final line break, so no empty line follows the match. */
const LONG_DOCUMENT = [
  ...Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1} of the notes.`),
  `Last line ${"word ".repeat(10)}needle`,
].join("\n\n");

test("find leaves a match at the top of the page in view and clear of the card", async () => {
  // A match in the frontmatter table and one at the end of a long first line.
  // Both sat under the card when it floated over the top right of the page,
  // which cannot scroll any higher.
  const files = {
    "top-frontmatter.md": "---\ntitle: Quarterly needle notes\nowner: Ann\n---\n\n# Planning\n\nThe group meets on Monday.\n",
    "top-first-line.md": "The first line of these notes is long, and it runs on to a needle at its end and then wraps onto a second line of text so the paragraph is long.\n\nSecond paragraph.\n",
  };
  await launch();
  const find = page.getByRole("textbox", { name: "Find in document" });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(directory, name);
    await writeFile(file, text);
    await chooseOpen(file);
    await expect(page).toHaveTitle(`${name} — md-easy`);
    await page.keyboard.press("ControlOrMeta+f");
    await find.fill("needle");
    await expect(page.locator(".find-count")).toHaveText("1 of 1");
    await expect.poll(currentMatchProblem).toBe("");
    // The replace row makes the card taller, and opening it searches again.
    await page.keyboard.press("Control+h");
    await expect(page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
    await twoFrames();
    expect(await currentMatchProblem()).toBe("");
    // The match was in view and clear of the card, so the page stayed at the top.
    expect(await page.locator(".editor-area").evaluate((area) => area.scrollTop)).toBe(0);
    await page.keyboard.press("Escape");
  }
});

test("find lifts a match at the end of a long document clear of the card", async () => {
  const file = path.join(directory, "find-end.md");
  await writeFile(file, LONG_DOCUMENT);
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror p").first()).toHaveText("Paragraph 1 of the notes.");
  const area = page.locator(".editor-area");
  const find = page.getByRole("textbox", { name: "Find in document" });
  await page.keyboard.press("ControlOrMeta+f");
  await find.fill("needle");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await expect.poll(currentMatchProblem).toBe("");
  // The card sits 12px above the status bar, clear of the scroll bar, and the
  // replace row makes it grow upward.
  const findOnly = await cardInsets();
  expect([findOnly.bottom, findOnly.right]).toEqual([12, 24]);
  await page.keyboard.press("Control+h");
  const withReplace = await cardInsets();
  expect([withReplace.bottom, withReplace.right]).toEqual([12, 24]);
  expect(withReplace.height).toBeGreaterThan(findOnly.height);
  await twoFrames();
  expect(await currentMatchProblem()).toBe("");

  // The user scrolls up until the match is under the card. The next find step
  // lifts it clear.
  const places = () =>
    page.evaluate(() => {
      const match = document.querySelector(".md-find-current")!.getBoundingClientRect();
      const card = document.querySelector(".find-bar")!.getBoundingClientRect();
      return { matchTop: match.top, matchBottom: match.bottom, cardTop: card.top };
    });
  const scrollUp = (by: number) => area.evaluate((element, by) => (element.scrollTop -= by), by);
  const lifted = await places();
  await scrollUp(lifted.cardTop + 8 - lifted.matchTop);
  expect(await currentMatchProblem()).toContain("under the card");
  await find.press("Enter");
  await expect.poll(currentMatchProblem).toBe("");
  // A match in view and clear of the card stays where it is, though it is not
  // centred above the card.
  const clear = await places();
  const scrolled = await scrollUp(Math.floor((clear.cardTop - clear.matchBottom) / 2));
  await find.press("Enter");
  await twoFrames();
  expect(await currentMatchProblem()).toBe("");
  expect(await area.evaluate((element) => element.scrollTop)).toBe(scrolled);

  // In the split the card covers the bottom right of the Markdown pane, and the
  // document pane keeps the match in view.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  await expect.poll(currentMatchProblem).toBe("");
  expect(await cardInsets()).toEqual(withReplace);
});

/** The find card's fields, buttons and check boxes that end outside the
 *  editor area or that a click on their middle would miss. */
function cardControlProblems(): Promise<string[]> {
  return page.evaluate(() => {
    const area = document.querySelector(".main-region")!.getBoundingClientRect();
    const controls = [...document.querySelectorAll<HTMLElement>(".find-bar input, .find-bar button")];
    return controls.flatMap((control) => {
      if (!control.getClientRects().length) return [];
      const box = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.closest("label")?.textContent ?? control.textContent;
      const where = `${name} at ${Math.round(box.left)}-${Math.round(box.right)} across`;
      if (box.left < area.left || box.right > area.right || box.top < area.top || box.bottom > area.bottom) {
        return [`${where} is outside the editor area`];
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit && control.contains(hit) ? [] : [`${where} is covered`];
    });
  });
}

test("the find card fits a narrow window and find lifts a match clear of it", async () => {
  const file = path.join(directory, "find-narrow.md");
  await writeFile(file, LONG_DOCUMENT);
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror p").first()).toHaveText("Paragraph 1 of the notes.");
  const find = page.getByRole("textbox", { name: "Find in document" });
  const replace = page.getByRole("textbox", { name: "Replace with" });
  const fieldWidths = () =>
    page.evaluate(() => [".find-field", ".find-replace-row input"].map((field) => document.querySelector(field)!.getBoundingClientRect().width));
  await page.keyboard.press("ControlOrMeta+h");
  await find.fill("needle");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  const wideFields = await fieldWidths();
  await page.keyboard.press("Escape");
  for (const width of [600, 520, 480]) {
    await app!.evaluate(({ BrowserWindow }, contentWidth) => BrowserWindow.getAllWindows()[0]!.setContentSize(contentWidth, 600), width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    // Opening the card searches again and scrolls to the match.
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator(".find-count")).toHaveText("1 of 1");
    expect(await cardControlProblems()).toEqual([]);
    await expect.poll(currentMatchProblem).toBe("");
    await page.keyboard.press("Control+h");
    await expect(replace).toBeVisible();
    expect(await cardControlProblems()).toEqual([]);
    // The fields keep the width they have in a wide window, and the card
    // keeps its place 12px above the status bar and clear of the scroll bar.
    expect(await fieldWidths()).toEqual(wideFields);
    const insets = await cardInsets();
    expect([insets.bottom, insets.right]).toEqual([12, 24]);
    await twoFrames();
    expect(await currentMatchProblem()).toBe("");
    await page.keyboard.press("Escape");
    await expect(page.locator(".find-bar")).toBeHidden();
  }

  // The card is taller in a narrow window. The user scrolls up until the match
  // is under it, and the next find step lifts the match clear.
  await page.keyboard.press("ControlOrMeta+h");
  await expect(replace).toBeVisible();
  await expect.poll(currentMatchProblem).toBe("");
  await page.locator(".editor-area").evaluate((element) => {
    const match = document.querySelector(".md-find-current")!.getBoundingClientRect();
    element.scrollTop -= document.querySelector(".find-bar")!.getBoundingClientRect().top + 8 - match.top;
  });
  expect(await currentMatchProblem()).toContain("under the card");
  await find.press("Enter");
  await expect.poll(currentMatchProblem).toBe("");
});

test("find in the Markdown view lifts a match on the last line clear of the card", async () => {
  const file = path.join(directory, "find-end-markdown.md");
  await writeFile(file, LONG_DOCUMENT);
  await launch(file);
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const pane = page.locator(".editor-pane-raw:not([hidden])");
  const firstLine = pane.locator(".cm-line").filter({ hasText: "Paragraph 1 of the notes." });
  await expect(firstLine).toBeVisible();
  // How far the pane scrolls past the source's last line.
  const roomBelow = () =>
    pane.evaluate(async (element) => {
      element.scrollTop = element.scrollHeight;
      // CodeMirror draws the lines it scrolled to in its next frame.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      element.scrollTop = element.scrollHeight;
      const last = [...element.querySelectorAll(".cm-line")].at(-1)!;
      return Math.round(element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
    });
  const roomBefore = await roomBelow();
  await pane.evaluate((element) => { element.scrollTop = 0; });

  const find = page.getByRole("textbox", { name: "Find in document" });
  await page.keyboard.press("ControlOrMeta+f");
  await find.fill("needle");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  // The source has almost no room below its last line, so the page gets
  // enough to lift that line clear of the card.
  await expect.poll(currentMatchProblem).toBe("");
  expect((await cardInsets()).bottom).toBe(12);
  // The replace row makes the card reach over the match, and opening it
  // searches again, which makes more room and lifts the match clear.
  await page.keyboard.press("Control+h");
  await expect(page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
  await expect.poll(currentMatchProblem).toBe("");
  expect((await cardInsets()).bottom).toBe(12);
  // F3 from the source also lifts the match clear.
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await firstLine.click();
  await expect(page.locator(".find-count")).toHaveText("0 of 1");
  await page.keyboard.press("F3");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await expect.poll(currentMatchProblem).toBe("");

  // Closing find takes the room away. A page scrolled away from the end stays put.
  await pane.evaluate((element) => { element.scrollTop = 200; });
  await page.locator(".find-bar").getByRole("button", { name: "Close find" }).click();
  await expect(page.locator(".find-bar")).toBeHidden();
  await twoFrames();
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(200);
  expect(await roomBelow()).toBe(roomBefore);
});

/** The text of `line`, a paragraph or a source line that wraps, from its
 *  start through the first word on its second line. */
function throughSecondLine(line: Locator): Promise<string> {
  return line.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error("The line does not start with its text.");
    const word = document.createRange();
    let firstTop: number | undefined;
    for (const { 0: found, index } of text.data.matchAll(/\S+/g)) {
      word.setStart(text, index);
      word.setEnd(text, index + found.length);
      const top = word.getBoundingClientRect().top;
      firstTop ??= top;
      if (top > firstTop + 1) return text.data.slice(0, index + found.length);
    }
    throw new Error("The line does not wrap.");
  });
}

test("find lifts a match that wraps onto another line clear of the card", async () => {
  // The match runs from the start of the last paragraph to the first word on
  // its second line. Both of its ends lie left of the card, while its first
  // line runs on under the card.
  const terms = Array.from({ length: 60 }, (_, index) => `term${index + 1}`).join(" ");
  const file = path.join(directory, "find-wrapped.md");
  await writeFile(file, [...Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1} of the notes.`), terms].join("\n\n"));
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror p").first()).toHaveText("Paragraph 1 of the notes.");
  const find = page.getByRole("textbox", { name: "Find in document" });
  for (const [layout, scroller, line] of [
    ["Markdown", ".editor-pane-raw:not([hidden])", ".cm-line"],
    ["Document", ".editor-area", ".milkdown .ProseMirror p"],
  ] as const) {
    await page.getByRole("radio", { name: layout, exact: true }).click();
    const pane = page.locator(scroller);
    // CodeMirror draws the last line once the page scrolls to it.
    await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const query = await throughSecondLine(pane.locator(line).filter({ hasText: "term1 " }));
    await pane.evaluate((element) => { element.scrollTop = 0; });
    // The replace row makes the card reach higher.
    await page.keyboard.press("Control+h");
    await find.fill(query);
    await expect(page.locator(".find-count")).toHaveText("1 of 1");
    await expect.poll(currentMatchProblem).toBe("");
    // The user scrolls up until the match's first line is under the card. The
    // next find step lifts it clear.
    await pane.evaluate((element) => {
      const match = [...document.querySelectorAll(".md-find-current")].find((part) => part.getClientRects().length)!;
      element.scrollTop -= document.querySelector(".find-bar")!.getBoundingClientRect().top + 8 - match.getClientRects()[0]!.top;
    });
    expect(await currentMatchProblem()).toContain("under the card");
    await find.press("Enter");
    await expect.poll(currentMatchProblem).toBe("");
    await page.keyboard.press("Escape");
    await expect(page.locator(".find-bar")).toBeHidden();
  }
});

test("Tab in the split moves from the document pane to the Markdown pane, then to the divider", async () => {
  const { documentLine, markdownLine } = await openSplit("tab-split.md");
  await documentLine.click();
  await page.keyboard.press("Tab");
  await expect(page.locator(".editor-pane-raw .cm-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("separator", { name: "Resize Markdown split" })).toBeFocused();
  await expect(markdownLine).toHaveText("First line.");
});

test("a click in the split's Markdown pane closes the slash menu and leaves Enter to that pane", async () => {
  const { file, documentLine, markdownLine } = await openSplit("slash-blur.md");
  await typeAtEnd(documentLine, "\n/");
  const menu = page.getByRole("listbox", { name: "Insert block" });
  await expect(menu).toBeVisible();
  // Click once the Markdown pane shows the new line, not while it changes.
  await expect(page.locator(".editor-pane-raw .cm-line").nth(2)).toHaveText("/");
  await markdownLine.click();
  await expect(menu).toBeHidden();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Typed.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("First line.\nTyped.\n\n/\n");
});

test("Ctrl+Z takes back frontmatter table edits and a Replace all that changed the table", async () => {
  const file = path.join(directory, "frontmatter-undo.md");
  await writeFile(file, "---\ntitle: Draft notes # keep\nstatus: draft\n---\n\nThe draft body.\n");
  await launch(file);
  const title = page
    .locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: "title", exact: true }) })
    .locator(".frontmatter-value-edit");
  const body = page.locator(".milkdown .ProseMirror p").first();
  await typeAtEnd(title, " v2");
  await expect(page).toHaveTitle("● frontmatter-undo.md — md-easy");
  // The caret stays in the cell, so typing goes on there.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(title).toHaveText("Draft notes # keep");
  await expect(page).toHaveTitle("frontmatter-undo.md — md-easy");
  await page.keyboard.type("!");
  await expect(title).toHaveText("Draft notes # keep!");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(title).toHaveText("Draft notes # keep");

  await body.click();
  await page.keyboard.press("ControlOrMeta+h");
  await page.getByRole("textbox", { name: "Find in document" }).fill("draft");
  await page.getByRole("textbox", { name: "Replace with" }).fill("final");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(title).toHaveText("final notes # keep");
  await page.getByRole("button", { name: "Close find" }).click();
  // One Ctrl+Z in the document takes back the table's and the body's replacements.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(title).toHaveText("Draft notes # keep");
  await expect(body).toHaveText("The draft body.");
  await expect(page).toHaveTitle("frontmatter-undo.md — md-easy");
  await page.keyboard.press("ControlOrMeta+y");
  await expect(title).toHaveText("final notes # keep");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("---\ntitle: final notes # keep\nstatus: final\n---\n\nThe final body.\n");
});

test("Undo and Redo in the native menu go through the editors' undo history", async () => {
  const file = path.join(directory, "menu-undo.md");
  const original = "---\ntitle: Draft notes # keep\nstatus: draft\n---\n\nThe draft body.\n";
  await writeFile(file, original);
  await launch(file);
  // Keep each native menu instead of showing it, so the test can choose its items.
  await app!.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      Reflect.set(globalThis, "shownMenu", this);
    };
  });
  /** Shift+right-click `target`, which opens the native menu, and choose `label` there. */
  const choose = async (target: Locator, label: string): Promise<void> => {
    await app!.evaluate(() => Reflect.set(globalThis, "shownMenu", null));
    await target.click({ button: "right", modifiers: ["Shift"] });
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "shownMenu") !== null)).toBe(true);
    await app!.evaluate(({ BrowserWindow }, wanted) => {
      const menu: Electron.Menu = Reflect.get(globalThis, "shownMenu");
      const window = BrowserWindow.getAllWindows()[0]!;
      menu.items.find((item) => item.label === wanted)!.click(undefined, window, window.webContents);
    }, label);
  };
  const cell = (key: string) =>
    page.locator(".frontmatter-table tr", { has: page.getByRole("rowheader", { name: key, exact: true }) }).locator(".frontmatter-value-edit");

  await typeAtEnd(cell("title"), " v2");
  await typeAtEnd(cell("status"), " b");
  await choose(cell("status"), "Undo");
  await expect(cell("status")).toHaveText("draft");
  await choose(cell("status"), "Undo");
  await expect(cell("title")).toHaveText("Draft notes # keep");
  await expect(page).toHaveTitle("menu-undo.md — md-easy");
  await choose(cell("title"), "Redo");
  await expect(cell("title")).toHaveText("Draft notes # keep v2");

  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const line = page.locator(".cm-line", { hasText: "The draft body." });
  await typeAtEnd(line, " Typed.");
  await choose(line, "Undo");
  await expect(line).toHaveText("The draft body.");
  await choose(line, "Redo");
  await expect(line).toHaveText("The draft body. Typed.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(original.replace("# keep", "# keep v2").replace("body.", "body. Typed."));
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

test("find reaches a match far along a code line without scrolling the page sideways", async () => {
  // A table wider than the page lets the page scroll sideways, and the code
  // block's line runs far past the block's right edge.
  const columns = Array.from({ length: 14 }, (_, index) => index + 1);
  const table = [
    `| ${columns.map((column) => `Column${column}heading`).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    `| ${columns.map((column) => `value${column}value`).join(" | ")} |`,
  ].join("\n");
  const code = ["```js", `const line = "${"q".repeat(160)} needle";`, "```"].join("\n");
  const file = path.join(directory, "find-code-line.md");
  await writeFile(file, ["# Find", table, "A needle in a paragraph.", code].join("\n\n") + "\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Find");
  const input = page.getByRole("textbox", { name: "Find in document" });
  const count = page.locator(".find-count");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(input).toBeFocused();
  for (const [layout, pageSelector] of [["Document", ".editor-area"], ["Split", ".editor-pane-wysiwyg"]] as const) {
    await page.getByRole("radio", { name: layout, exact: true }).click();
    const block = page.locator(`${pageSelector} .milkdown-code-block`);
    // Crepe draws the block's editor once the block is on screen.
    await expect(block.locator(".cm-editor")).toBeVisible();
    expect(await page.locator(pageSelector).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await input.fill("");
    await input.fill("needle");
    await expect(count).toHaveText("1 of 2");
    await input.press("Enter");
    await expect(count).toHaveText("2 of 2");
    await expect(block.locator(".md-find-current")).toBeInViewport({ ratio: 1 });
    await twoFrames();
    expect(await currentMatchProblem()).toBe("");
    // The block scrolls its line to the match, and the page stays where it is.
    expect(await block.locator(".cm-scroller").evaluate((scroller) => scroller.scrollLeft)).toBeGreaterThan(0);
    expect(await page.locator(pageSelector).evaluate((element) => element.scrollLeft)).toBe(0);
  }
});

test("a one-word edit in the document view saves only that line", async () => {
  const file = path.join(directory, "release.md");
  // The document view writes almost every block here in its own way: the
  // setext and closed headings, the reference links and their definitions, the
  // ")" and "*" lists, the table's spacing, the two-space line break, the
  // character references and escapes, the indented and "~~~" code, the "***"
  // rule and the two blank lines.
  const markdown = [
    "---",
    "title: Release notes",
    "---",
    "",
    "Release notes",
    "=============",
    "",
    "Thanks to everyone who tested",
    "",
    "See the [changelog][log] and the [FAQ].",
    "",
    "",
    "## Steps ##",
    "",
    "1) Back up the data",
    "2) Install the update",
    "",
    "* Restart the server",
    "* Check the logs",
    "",
    "| Feature | Status |",
    "|:--------|-------:|",
    "| Sync    | Done   |",
    "",
    "Line one with two spaces  ",
    "line two, &copy; 2026 &amp; \\[not a link\\].",
    "",
    "    indented code",
    "",
    "~~~",
    "fenced with tildes",
    "~~~",
    "",
    "***",
    "",
    '[log]: https://example.com/changelog "Changelog"',
    "[FAQ]: https://example.com/faq",
    "",
  ].join("\n");
  await writeFile(file, markdown);
  await launch(file);
  await typeAtEnd(page.locator(".milkdown .ProseMirror > p", { hasText: "Thanks to everyone" }), " early");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(markdown.replace("who tested\n", "who tested early\n"));
  await expect(page).toHaveTitle("release.md — md-easy");
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

test("a long path in the status bar is cut short to fit a narrow window", async () => {
  // Folders long enough that the path needs more room than a 600px window has.
  const folder = path.join(directory, "quarterly-planning-documents", "team-meetings-and-weekly-reviews", "october-sessions");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "notes.md");
  await writeFile(file, "# Notes\n\nOne paragraph.\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Notes");
  await expect(page.locator(".status-left")).toHaveText(file);
  await expect(page.locator(".status-left")).toHaveAttribute("title", file);
  for (const width of [600, 480]) {
    await app!.evaluate(({ BrowserWindow }, contentWidth) => BrowserWindow.getAllWindows()[0]!.setContentSize(contentWidth, 600), width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const layout = await page.getByTestId("app-shell").evaluate((shell) => {
      const status = shell.querySelector(".status-left")!;
      return {
        shell: shell.scrollWidth,
        rows: [...shell.children].map((row) => row.getBoundingClientRect().right),
        wordCount: shell.querySelector(".status-right")!.getBoundingClientRect().right,
        path: { shown: status.clientWidth, whole: status.scrollWidth },
      };
    });
    // The toolbar, tabs, editor and status bar, with its word count, end
    // inside the window, and only the path gives way.
    expect(layout.shell).toBe(width);
    expect(Math.max(...layout.rows)).toBeLessThanOrEqual(width);
    expect(layout.wordCount).toBeLessThanOrEqual(width);
    expect(layout.path.whole).toBeGreaterThan(layout.path.shown);
  }
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

test("a click right of the text in a table cell puts the caret after it, and a row handle still moves its row", async () => {
  const file = path.join(directory, "table-click.md");
  // The wider value leaves room right of the text in the cells above it.
  await writeFile(file, "Intro.\n\n| Name | Notes |\n| --- | --- |\n| short text | a longer note |\n| a much wider value |  |\n");
  await launch(file);
  const intro = page.locator(".milkdown .ProseMirror > p").first();
  const table = page.locator(".milkdown .ProseMirror table.children");
  /** Put the caret in the intro, click inside `cell`'s paragraph halfway
   *  between the end of its text and the paragraph's right edge, and type
   *  `text`. Crepe's table selected the whole paragraph a frame after such a
   *  click, so typing replaced the cell's text. */
  const typeRightOfText = async (cell: Locator, text: string): Promise<void> => {
    await intro.click();
    const room = await cell.locator("p").evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const textBox = range.getBoundingClientRect();
      const box = paragraph.getBoundingClientRect();
      // An empty paragraph's range has no box.
      const textEnd = textBox.width > 0 ? textBox.right : box.left;
      return { textEnd, right: box.right, y: box.top + box.height / 2 };
    });
    expect(room.right - room.textEnd).toBeGreaterThan(20);
    await page.mouse.click((room.textEnd + room.right) / 2, room.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(table.locator(".ProseMirror-selectednode")).toHaveCount(0);
    await page.keyboard.type(text);
  };
  await typeRightOfText(table.locator("th").first(), "s");
  await typeRightOfText(table.locator("td").filter({ hasText: "short text" }), " here");
  await typeRightOfText(table.locator("tr").last().locator("td").last(), "y");

  // Crepe shows a row's drag handle while the pointer is over the row, and
  // hides the handles 200 ms after the pointer leaves the table, as it did for
  // each click in the intro. Let the last of those timers pass first.
  await page.waitForTimeout(300);
  const lastRow = table.locator("tr").last();
  await lastRow.locator("td").first().hover();
  const handle = page.locator('[data-role="row-drag-handle"]');
  await expect(handle).toHaveAttribute("data-show", "true");
  const rowBox = await lastRow.boundingBox();
  if (!rowBox) throw new Error("The last row is not shown.");
  // The handle moves to the row once floating-ui has placed it.
  await expect.poll(async () => {
    const box = await handle.boundingBox();
    return !!box && Math.abs(box.y + box.height / 2 - (rowBox.y + rowBox.height / 2)) < 2;
  }).toBe(true);
  const from = await handle.boundingBox();
  const to = await table.locator("tr").nth(1).boundingBox();
  if (!from || !to) throw new Error("The handle or the target row is not shown.");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 4);
  // Crepe shows the dragged row's preview a frame after the drag starts.
  await expect(page.locator(".milkdown-table-block .drag-preview")).toHaveAttribute("data-show", "true");
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 8 });
  // Crepe reads the row under the pointer at most every 20 ms, so move once
  // more after a pause for it to read the target row before the drop.
  await page.waitForTimeout(100);
  await page.mouse.move(to.x + 32, to.y + to.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Intro.",
    "",
    "| Names              | Notes         |",
    "| ------------------ | ------------- |",
    "| a much wider value | y             |",
    "| short text here    | a longer note |",
    "",
  ].join("\n"));
});

/** Press on the grip of Crepe's block handle beside `block` and move a little,
 *  which starts dragging the block. */
async function startBlockDrag(block: Locator): Promise<void> {
  const box = (await block.boundingBox())!;
  const handle = page.locator(".milkdown-block-handle");
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  // Crepe shows the handle beside the block under the pointer once
  // floating-ui has placed it.
  await expect.poll(async () => {
    const handleBox = await handle.boundingBox();
    if (!handleBox || (await handle.getAttribute("data-show")) !== "true") return false;
    const middle = handleBox.y + handleBox.height / 2;
    return middle > box.y && middle < box.y + box.height && handleBox.x + handleBox.width <= box.x;
  }).toBe(true);
  const grip = await centerOf(handle.locator(".operation-item").nth(1));
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 5, grip.y + 5, { steps: 3 });
}

/** The height on the page of the drop indicator's line, or null while it is
 *  hidden. It is read from the place the line is given, since the line moves
 *  there over a fifth of a second. */
async function dropLineY(): Promise<number | null> {
  return page.locator(".milkdown-drop-indicator").evaluate((line) => {
    if (!(line instanceof HTMLElement) || line.style.display === "none") return null;
    const top = /translate\([-\d.]+px, ([-\d.]+)px\)/.exec(line.style.transform)?.[1];
    return top === undefined ? null : Number(top) + Number.parseFloat(line.style.height) / 2;
  });
}

test("a block dragged by its handle onto a table, or beside it, goes in above or below the whole table, where the drop line shows", async () => {
  const file = path.join(directory, "block-drag-table.md");
  await writeFile(file, "Intro.\n\nMove me.\n\n| Head A | Head B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |\n\nEnd.\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  const tableBox = async () => (await page.locator(".milkdown-table-block").boundingBox())!;
  // Onto cell b3, in the table's lower half. Crepe's table kept this drop from
  // the editor, so it did nothing, or once the page had scrolled, Chromium put
  // a copy of the block's text into the cell.
  await startBlockDrag(editor.locator("p", { hasText: "Move me." }));
  const b3 = await centerOf(editor.locator("td", { hasText: "b3" }));
  await page.mouse.move(b3.x, b3.y, { steps: 10 });
  await page.mouse.move(b3.x + 1, b3.y);
  const below = await tableBox();
  await expect.poll(dropLineY).toBeCloseTo(below.y + below.height, 0);
  await page.mouse.up();
  await expect(editor.locator(".milkdown-table-block + p")).toHaveText("Move me.");
  // Into the margin left of row a1, in the table's upper half. Crepe put the
  // block between the rows there, which cut the table in two.
  await startBlockDrag(editor.locator("p", { hasText: "End." }));
  const a1 = (await editor.locator("td", { hasText: "a1" }).boundingBox())!;
  await page.mouse.move(a1.x - 30, a1.y + a1.height / 2, { steps: 10 });
  await page.mouse.move(a1.x - 31, a1.y + a1.height / 2);
  await expect.poll(dropLineY).toBeCloseTo((await tableBox()).y, 0);
  await page.mouse.up();
  // A drag across a cell's text still selects it.
  const b2 = editor.locator("td p", { hasText: "b2" });
  const text = await b2.evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const { left, right, top, bottom } = range.getBoundingClientRect();
    return { left, right, y: (top + bottom) / 2 };
  });
  await page.mouse.move(text.left - 1, text.y);
  await page.mouse.down();
  await page.mouse.move(text.right + 1, text.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.type("B2");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Intro.",
    "",
    "End.",
    "",
    "| Head A | Head B |",
    "| ------ | ------ |",
    "| a1     | b1     |",
    "| a2     | B2     |",
    "| a3     | b3     |",
    "",
    "Move me.",
    "",
  ].join("\n"));
});

test("a block dragged by its handle onto a tall table while the page scrolls goes in above the table once, and is scrolled into view", async () => {
  const file = path.join(directory, "block-drag-scroll.md");
  const fillers = Array.from({ length: 20 }, (_, index) => `Filler ${index + 1}.`);
  const rows = Array.from({ length: 50 }, (_, index) => `| a${index + 1} | b${index + 1} |`);
  const table = ["| Head A | Head B |", "| --- | --- |", ...rows].join("\n");
  await writeFile(file, ["Intro.", "Move me.", ...fillers, table, "End."].join("\n\n") + "\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  const moved = editor.locator("p", { hasText: "Move me." });
  await startBlockDrag(moved);
  // Hold the pointer at the bottom of the page, where the page scrolls as the
  // pointer moves, until one of rows a18 to a24, in the table's upper half and
  // with the table's top out of view, is under it. The scroll speeds up, so it
  // can pass a single row between two looks. Each update of such a drag lands
  // on a new element. Chromium sent only a dragenter then, which Crepe's table
  // did not cancel, so it dropped a copy of the block's text into the cell
  // itself.
  const area = (await page.locator(".editor-area").boundingBox())!;
  const x = (await moved.boundingBox())!.x + 40;
  const y = area.y + area.height - 6;
  await page.mouse.move(x, y, { steps: 10 });
  let wiggle = 0;
  await expect.poll(async () => {
    wiggle += 1;
    await page.mouse.move(x + (wiggle % 2), y);
    return page.evaluate(([pointX, pointY]) => document.elementFromPoint(pointX, pointY)?.closest("td")?.textContent ?? null, [x, y]);
  }, { timeout: 30_000, intervals: [20] }).toMatch(/^a(1[89]|2[0-4])$/);
  await page.mouse.up();
  // The table's top was far above the view, and the page scrolls to the block.
  await expect.poll(async () => {
    const box = (await moved.boundingBox())!;
    return box.y >= area.y && box.y + box.height <= area.y + area.height;
  }).toBe(true);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["Intro.", ...fillers, "Move me.", table, "End."].join("\n\n") + "\n");
});

test("a block dragged beside a table goes in where the pointer is, where the drop line shows, after the page scrolled under the still pointer", async () => {
  const file = path.join(directory, "block-drag-still.md");
  const fillers = Array.from({ length: 20 }, (_, index) => `Filler ${index + 1}.`);
  const table = "| Head A | Head B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |";
  await writeFile(file, ["Intro.", "Move me.", table, "End.", ...fillers].join("\n\n") + "\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  await startBlockDrag(editor.locator("p", { hasText: "Move me." }));
  // Left of the table, at the top of row a2, where the edge nearest the
  // pointer is between rows a1 and a2.
  const tableBox = (await editor.locator(".milkdown-table-block").boundingBox())!;
  const a2 = (await editor.locator("td", { hasText: "a2" }).boundingBox())!;
  const point = { x: tableBox.x - 25, y: a2.y + 4 };
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await page.mouse.move(point.x + 1, point.y);
  await expect.poll(dropLineY).not.toBeNull();
  // Scroll the page under the still pointer until the lower half of "End."
  // is under it. Crepe's drop indicator kept the edge between the rows for
  // the same point, so the drop cut the table in two, and its line stayed
  // where it was on the screen.
  const end = editor.locator("p", { hasText: /^End\.$/ });
  const endBox = (await end.boundingBox())!;
  await page.locator(".editor-area").evaluate((area, delta) => {
    area.scrollTop += delta;
  }, endBox.y + endBox.height * 0.75 - point.y);
  const scrolled = (await end.boundingBox())!;
  expect(scrolled.y + scrolled.height / 2).toBeLessThan(point.y);
  expect(scrolled.y + scrolled.height).toBeGreaterThan(point.y);
  await expect.poll(dropLineY).toBeCloseTo(scrolled.y + scrolled.height, 0);
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["Intro.", table, "End.", "Move me.", ...fillers].join("\n\n") + "\n");
});

test("a block copied by its handle onto the upper half of the table or code block right below it goes in above it, where the drop line shows", async () => {
  const file = path.join(directory, "block-copy-table.md");
  const table = "| Head A | Head B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |";
  const fence = "```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```";
  await writeFile(file, `Intro.\n\nCopy me.\n\n${table}\n\nCopy too.\n\n${fence}\n\nEnd.\n`);
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  // The key that makes a drag copy, as ProseMirror reads it.
  const copyKey = process.platform === "darwin" ? "Alt" : "Control";
  // Onto cell b1, in the table's upper half, and onto the code block near its
  // top left corner. A move would leave the block where it is there, so the
  // drop line hid, though the copy went in.
  const codeBlock = editor.locator(".milkdown-code-block");
  const drags = [
    { text: "Copy me.", block: editor.locator(".milkdown-table-block"), at: () => centerOf(editor.locator("td", { hasText: "b1" })) },
    { text: "Copy too.", block: codeBlock, at: async () => {
      const { x, y } = (await codeBlock.boundingBox())!;
      return { x: x + 10, y: y + 10 };
    } },
  ];
  for (const { text, block, at } of drags) {
    await page.keyboard.down(copyKey);
    await startBlockDrag(editor.locator("p", { hasText: text }));
    const point = await at();
    await page.mouse.move(point.x, point.y, { steps: 10 });
    await page.mouse.move(point.x + 1, point.y);
    const box = (await block.boundingBox())!;
    await expect.poll(dropLineY).toBeCloseTo(box.y, 0);
    await page.mouse.up();
    await page.keyboard.up(copyKey);
    await expect(editor.locator("p", { hasText: text })).toHaveCount(2);
  }
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(`Intro.\n\nCopy me.\n\nCopy me.\n\n${table}\n\nCopy too.\n\nCopy too.\n\n${fence}\n\nEnd.\n`);
});

test("a block dragged by its handle onto a code block, math block or diagram goes in above or below it, where the drop line shows", async () => {
  const file = path.join(directory, "block-drag-code.md");
  const code = "```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```";
  const math = "$$\nE = mc^2\n$$";
  const diagram = "```mermaid\ngraph TD\n  A --> B\n```";
  await writeFile(file, ["Intro.", "First.", code, "Second.", math, diagram, "Third.", "End."].join("\n\n") + "\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  const blocks = editor.locator(".milkdown-code-block");
  await expect(blocks.nth(1).locator(".katex")).toBeVisible();
  await expect(blocks.nth(2).locator(".mermaid-preview svg")).toBeVisible();
  // Crepe's code block view kept every drag event from ProseMirror. Its
  // CodeMirror editor put the text of a block dropped on the code into the
  // code, and the block stayed where it was. Over the toolbar or a preview,
  // nothing took the drop.
  const drags: { text: string; block: Locator; part: number }[] = [
    // The last line of the code, in the block's lower half.
    { text: "First.", block: blocks.nth(0), part: 0.75 },
    // The math block's lower half.
    { text: "Second.", block: blocks.nth(1), part: 0.75 },
    // The diagram's code, in its upper half.
    { text: "Third.", block: blocks.nth(2), part: 0.15 },
  ];
  for (const { text, block, part } of drags) {
    await block.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await startBlockDrag(editor.locator("p", { hasText: text }));
    const box = (await block.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height * part };
    await page.mouse.move(point.x, point.y, { steps: 10 });
    await page.mouse.move(point.x + 1, point.y);
    const edge = part < 0.5 ? box.y : box.y + box.height;
    await expect.poll(dropLineY).toBeCloseTo(edge, 0);
    await page.mouse.up();
    await expect(editor.locator("p", { hasText: text })).toHaveCount(1);
  }
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(["Intro.", code, "First.", math, "Second.", "Third.", diagram, "End."].join("\n\n") + "\n");
});

test("selected text dragged onto a code block goes in below it, and text from another app goes into the code", async () => {
  const file = path.join(directory, "text-drag-code.md");
  await writeFile(file, "Intro with WORD here.\n\n```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\n\nEnd.\n");
  await launch(file);
  const editor = page.locator(".milkdown .ProseMirror");
  const block = editor.locator(".milkdown-code-block");
  const word = await editor.locator("p", { hasText: "WORD" }).evaluate((paragraph) => {
    const text = paragraph.firstChild!;
    const start = text.textContent!.indexOf("WORD");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 4);
    const { x, y, width, height, right } = range.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2, end: right };
  });
  // Select the word from its end with the keyboard. A press right after a
  // double click would be a triple click, which selects the paragraph.
  await page.mouse.click(word.end, word.y);
  for (let i = 0; i < "WORD".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("WORD");
  await page.mouse.move(word.x, word.y);
  await page.mouse.down();
  await page.mouse.move(word.x + 6, word.y + 4, { steps: 3 });
  // Onto the last line of the code, in the block's lower half. CodeMirror put
  // a copy of the word into the code, and the word stayed in the paragraph.
  const last = await centerOf(block.locator(".cm-line", { hasText: "const z" }));
  await page.mouse.move(last.x, last.y, { steps: 10 });
  await page.mouse.move(last.x + 1, last.y);
  const box = (await block.boundingBox())!;
  await expect.poll(dropLineY).toBeCloseTo(box.y + box.height, 0);
  await page.mouse.up();
  await expect(editor.locator("p", { hasText: /^WORD$/ })).toHaveCount(1);
  // Text from another app, through Chromium's drag emulation, still goes into
  // the code at the pointer, here at the end of a line.
  const line = (await block.locator(".cm-line", { hasText: "const y" }).boundingBox())!;
  const point = { x: line.x + line.width - 10, y: line.y + line.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: "text/plain", data: " // from another app" }], dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: point.x, y: point.y - 2, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: point.x, y: point.y - 2, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: point.x, y: point.y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x: point.x, y: point.y, data });
  await cdp.detach();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(
    "Intro with  here.\n\n```js\nconst x = 1;\nconst y = 2; // from another app\nconst z = 3;\n```\n\nWORD\n\nEnd.\n",
  );
});

test("text from another app dropped on a table cell goes in below the table, where the drop line shows", async () => {
  const file = path.join(directory, "text-drop-table.md");
  const table = "| Head A | Head B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |";
  await writeFile(file, `Intro.\n\n${table}\n\nEnd.\n`);
  await launch(file);
  const tableBox = (await page.locator(".milkdown-table-block").boundingBox())!;
  const b3 = await centerOf(page.locator(".milkdown .ProseMirror td", { hasText: "b3" }));
  // Chromium's drag emulation, as for text dragged from another app. Crepe's
  // table kept this drop from the editor, so it did nothing, though the drop
  // line showed between the table's rows.
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: "text/plain", data: "From another app." }], dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: b3.x, y: b3.y - 4, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: b3.x, y: b3.y - 4, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: b3.x, y: b3.y, data });
  await expect.poll(dropLineY).toBeCloseTo(tableBox.y + tableBox.height, 0);
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x: b3.x, y: b3.y, data });
  await cdp.detach();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(`Intro.\n\n${table}\n\nFrom another app.\n\nEnd.\n`);
});

test("a click in a table cell in the split's document pane while cells are selected puts the caret there, right after a Markdown edit", async () => {
  const { file, markdownLine } = await openSplit("table-cells-split.md", "Intro.\n\n| Name | Notes |\n| --- | --- |\n| short text | a note |\n| a much wider value | b2 |\n");
  const table = page.locator(".editor-pane-wysiwyg table.children");
  const shortText = table.locator("td p").filter({ hasText: "short text" });
  // Drag from the text "short text" into the next row's second cell.
  const start = (await shortText.boundingBox())!;
  const end = (await table.locator("td").filter({ hasText: "b2" }).boundingBox())!;
  await page.mouse.move(start.x + 3, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 10, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(table.locator(".selectedCell")).toHaveCount(4);
  // The edit reaches the document pane when the next press there brings it up
  // to date. That ended the cell selection and drew the table again, so the
  // press landed on a cell that was gone and the focus left both panes.
  await typeAtEnd(markdownLine, " More.");
  const room = await shortText.evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const box = paragraph.getBoundingClientRect();
    return { x: (range.getBoundingClientRect().right + box.right) / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(room.x, room.y);
  await expect(page.locator(".editor-pane-wysiwyg .ProseMirror")).toBeFocused();
  await page.keyboard.type(" here");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe([
    "Intro. More.",
    "",
    "| Name               | Notes  |",
    "| ------------------ | ------ |",
    "| short text here    | a note |",
    "| a much wider value | b2     |",
    "",
  ].join("\n"));
});

/** The center of the box of the element `locator` finds. */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element is not shown.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Wait until floating-ui has placed Crepe's row or column `handle` beside
 *  the table cell `cell`, and return the handle's center. */
async function handleBeside(handle: Locator, cell: Locator, axis: "row" | "col"): Promise<{ x: number; y: number }> {
  const middle = await centerOf(cell);
  let at = { x: 0, y: 0 };
  await expect.poll(async () => {
    at = await centerOf(handle);
    return axis === "col" ? Math.abs(at.x - middle.x) < 2 : Math.abs(at.y - middle.y) < 2;
  }).toBe(true);
  return at;
}

/** Point at the middle of the table cell `cell` until Crepe shows its row or
 *  column `handle` beside it, and return the handle's center. Crepe hides the
 *  handles 200 ms after the pointer leaves the table, even when the pointer
 *  has come back, so the pointer moves again until the handle shows. */
async function hoverCell(cell: Locator, handle: Locator, axis: "row" | "col"): Promise<{ x: number; y: number }> {
  const middle = await centerOf(cell);
  let shift = 0;
  await expect.poll(async () => {
    shift = 1 - shift;
    await page.mouse.move(middle.x + shift, middle.y);
    return handle.getAttribute("data-show");
  }).toBe("true");
  return handleBeside(handle, cell, axis);
}

/** Hover the header cell `header`, click the column handle Crepe shows above
 *  it, and return the centers of the handle and of its menu's buttons. */
async function openColumnMenu(header: Locator, colHandle: Locator): Promise<{ handle: { x: number; y: number }; buttons: { x: number; y: number }[] }> {
  const handle = await hoverCell(header, colHandle, "col");
  await page.mouse.click(handle.x, handle.y);
  const menu = colHandle.locator(".button-group");
  await expect(menu).toBeVisible();
  // The menu can show before the handle is back over its column.
  await handleBeside(colHandle, header, "col");
  const buttons = await Promise.all([0, 1, 2, 3].map((index) => centerOf(menu.locator("button").nth(index))));
  return { handle, buttons };
}

/** Whether a click at `point` goes to Crepe's table handle `control`, or a
 *  button in it, while the handle shows. */
async function showsUnderPointer(control: Locator, point: { x: number; y: number }): Promise<boolean> {
  return control.evaluate((element, { x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target !== null && element.contains(target) && getComputedStyle(element).opacity === "1";
  }, point);
}

test("a column menu closes when a Markdown edit in the split changes its table, so a click where it was reaches the paragraph above", async () => {
  const { file } = await openSplit("table-menu-split.md", "Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n");
  const pane = page.locator(".editor-pane-wysiwyg");
  const table = pane.locator("table.children");
  const colHandle = pane.locator('[data-role="col-drag-handle"]');
  const { buttons } = await openColumnMenu(table.locator("th").filter({ hasText: "Notes" }), colHandle);
  const remove = buttons[3]!;

  // Type in a1 in the Markdown pane. The pointer leaves the table above the
  // menu, where Crepe does not close it.
  await page.mouse.move(remove.x, remove.y - 60, { steps: 3 });
  await page.locator(".editor-pane-raw .cm-line").filter({ hasText: "| a1 |" }).click();
  await page.keyboard.press("Home");
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("x");
  // The document pane takes the edit once typing pauses, which ends the column
  // selection. Crepe left the menu open in the faded handle, and a click where
  // its Delete button was showed it there and selected the column.
  await expect(table.locator("td").first()).toHaveText("a1x");
  await expect(colHandle.locator(".button-group")).toHaveAttribute("data-show", "false");
  await page.mouse.move(remove.x, remove.y, { steps: 3 });
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".milkdown-table-block") ?? null, remove)).toBeNull();
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.type("Z");
  await expect(table.locator(".selectedCell")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+s");
  // Z goes into the paragraph, wherever the click put the caret there. The
  // table keeps the text the Markdown pane has, since the document pane did
  // not change it.
  await expect.poll(async () => {
    const saved = await readFile(file, "utf8");
    const z = saved.indexOf("Z");
    return z >= 0 && z < saved.indexOf("|") && saved.replace("Z", "");
  }).toBe("Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1x | b1 |\n| a2 | b2 |\n");
});

test("a faded column handle or menu shows again under the pointer coming back from above the table, and takes the click", async () => {
  const file = path.join(directory, "table-column-fade.md");
  await writeFile(file, "Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n");
  await launch(file);
  const table = page.locator(".milkdown .ProseMirror table.children");
  const colHandle = page.locator('[data-role="col-drag-handle"]');

  // Open the Notes column's menu, slip off it onto the paragraph above for
  // longer than Crepe takes to fade the handle, and come back to Align center.
  const { buttons } = await openColumnMenu(table.locator("th").filter({ hasText: "Notes" }), colHandle);
  const center = buttons[1]!;
  await page.mouse.move(center.x, center.y, { steps: 4 });
  await page.mouse.move(center.x, center.y - 45, { steps: 4 });
  await expect(colHandle).toHaveCSS("opacity", "0");
  await page.mouse.move(center.x, center.y, { steps: 4 });
  await expect.poll(() => showsUnderPointer(colHandle, center)).toBe(true);
  await page.mouse.down();
  await page.mouse.up();

  // Leave the table upward beside the Name column's handle, then come down
  // from above onto the handle's upper half, which lies above the table.
  const name = table.locator("th").filter({ hasText: "Name" });
  const handle = await hoverCell(name, colHandle, "col");
  const nameBox = (await name.boundingBox())!;
  await page.mouse.move(handle.x + 30, nameBox.y + nameBox.height / 2, { steps: 3 });
  await page.mouse.move(handle.x + 30, handle.y - 40, { steps: 8 });
  await expect(colHandle).toHaveCSS("opacity", "0");
  await page.mouse.move(handle.x, handle.y - 40, { steps: 6 });
  const upperHalf = { x: handle.x, y: handle.y - 4 };
  await page.mouse.move(upperHalf.x, upperHalf.y, { steps: 8 });
  await expect.poll(() => showsUnderPointer(colHandle, upperHalf)).toBe(true);
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("th").first()).toHaveClass(/selectedCell/);
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  await expect(colHandle.locator(".button-group")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro paragraph above the table.\n\n| Name | Notes |\n| ---- | :---: |\n| a1   |   b1  |\n| a2   |   b2  |\n");
});

test("a faded row handle, row menu or add-row button shows under a pointer that comes back fast from left of the table before it takes the click", async () => {
  const file = path.join(directory, "table-row-fade.md");
  await writeFile(file, "Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |\n\nAfter.\n");
  await launch(file);
  const table = page.locator(".milkdown .ProseMirror table.children");
  const rowHandle = page.locator('[data-role="row-drag-handle"]');
  const addRow = page.locator('[data-role="x-line-drag-handle"]');
  const cell = (text: string): Locator => table.locator("td").filter({ hasText: text });
  const left = (await table.boundingBox())!.x;
  /** Leave the table to the left at the pointer's height `y`, wait for Crepe
   *  to fade `control`, come back to `point` in one move, as a fast pointer
   *  does, and click once `control` shows there. */
  const comeBackAndClick = async (control: Locator, y: number, point: { x: number; y: number }): Promise<void> => {
    await page.mouse.move(left - 200, y, { steps: 8 });
    await expect(control).toHaveCSS("opacity", "0");
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => showsUnderPointer(control, point)).toBe(true);
    await page.mouse.down();
    await page.mouse.up();
  };

  // A row handle sits across the table's left edge, by the row it was last
  // shown for.
  const handle = await hoverCell(cell("a2"), rowHandle, "row");
  await comeBackAndClick(rowHandle, handle.y, { x: left + 4, y: handle.y });
  await expect(table.locator("tr").nth(2).locator(".selectedCell")).toHaveCount(2);
  const menu = rowHandle.locator(".button-group");
  await expect(menu).toBeVisible();

  // The row menu's Delete button reaches out left of the table, over a1.
  const remove = await centerOf(menu.locator("button"));
  await comeBackAndClick(rowHandle, handle.y, { x: left + 6, y: remove.y });
  await expect(table.locator("tr")).toHaveCount(3);

  // The add-row button sits on the table's left edge, on the border Crepe
  // last showed it on, here below a1.
  const a1 = (await cell("a1").boundingBox())!;
  await page.mouse.move(a1.x + a1.width / 2, a1.y + a1.height - 3, { steps: 6 });
  await expect(addRow).toHaveAttribute("data-show", "true");
  const plus = await centerOf(addRow.locator(".add-button"));
  await comeBackAndClick(addRow, plus.y, { x: left + 4, y: plus.y - 4 });
  await expect(table.locator("tr")).toHaveCount(4);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro paragraph above the table.\n\n| Name | Notes |\n| ---- | ----- |\n| a1   | b1    |\n|      |       |\n| a3   | b3    |\n\nAfter.\n");
});

test("the add-column and add-row buttons select the new column or row and open its menu", async () => {
  const file = path.join(directory, "table-add.md");
  await writeFile(file, "Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n");
  await launch(file);
  const table = page.locator(".milkdown .ProseMirror table.children");
  const colHandle = page.locator('[data-role="col-drag-handle"]');
  const rowHandle = page.locator('[data-role="row-drag-handle"]');
  const a1Cell = table.locator("td").filter({ hasText: "a1" });
  let a1 = (await a1Cell.boundingBox())!;

  // Crepe shows a column's add button on the table's top edge while the
  // pointer is within 8 px of the column's border. Follow the border up to it.
  await page.mouse.move(a1.x + a1.width - 3, a1.y + a1.height / 2, { steps: 4 });
  const addColumn = page.locator('[data-role="y-line-drag-handle"]');
  await expect(addColumn).toHaveAttribute("data-show", "true");
  const plusColumn = await centerOf(addColumn.locator(".add-button"));
  await page.mouse.move(a1.x + a1.width - 2, plusColumn.y, { steps: 10 });
  await page.mouse.move(plusColumn.x, plusColumn.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
  const newColumn = table.locator("tr").locator("th, td").filter({ hasText: /^$/ });
  await expect(newColumn).toHaveCount(3);
  for (const cell of await newColumn.all()) await expect(cell).toHaveClass(/selectedCell/);
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  await expect(colHandle).toHaveCSS("opacity", "1");
  await expect(colHandle.locator(".button-group")).toBeVisible();

  // A row's add button sits on the table's left edge while the pointer is
  // within 8 px of the row's border. Follow the border to it.
  a1 = (await a1Cell.boundingBox())!;
  await page.mouse.move(a1.x + a1.width / 2, a1.y + a1.height - 3, { steps: 6 });
  const addRow = page.locator('[data-role="x-line-drag-handle"]');
  await expect(addRow).toHaveAttribute("data-show", "true");
  const plusRow = await centerOf(addRow.locator(".add-button"));
  await page.mouse.move(plusRow.x + 2, a1.y + a1.height - 2, { steps: 10 });
  await page.mouse.move(plusRow.x, plusRow.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").nth(2).locator(".selectedCell")).toHaveCount(3);
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  await expect(rowHandle).toHaveCSS("opacity", "1");
  await expect(rowHandle.locator(".button-group")).toBeVisible();
  await expect(colHandle.locator(".button-group")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro paragraph above the table.\n\n| Name |    | Notes |\n| ---- | :- | ----- |\n| a1   |    | b1    |\n|      |    |       |\n| a2   |    | b2    |\n");
});

test("Delete in a row's menu selects the row that moves into its place and opens its menu, so Delete again removes that row too", async () => {
  const file = path.join(directory, "table-row-delete.md");
  await writeFile(file, "Intro paragraph above the table.\n\n| Name | Notes |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |\n| a4 | b4 |\n");
  await launch(file);
  const table = page.locator(".milkdown .ProseMirror table.children");
  const rows = table.locator("tr");
  const rowHandle = page.locator('[data-role="row-drag-handle"]');
  const menu = rowHandle.locator(".button-group");
  const a2 = table.locator("td").filter({ hasText: "a2" });
  const handle = await hoverCell(a2, rowHandle, "row");
  await page.mouse.click(handle.x, handle.y);
  await expect(menu).toBeVisible();
  await handleBeside(rowHandle, a2, "row");
  // The menu sits straight above the handle.
  const remove = await centerOf(menu.locator("button"));
  await page.mouse.move(remove.x, remove.y, { steps: 4 });

  // Crepe's Delete acts on pointerdown, and the click after it reaches the
  // handle, which selects the row now in that place and opens its menu again.
  for (const next of ["a3", "a4"]) {
    await expect.poll(() => showsUnderPointer(rowHandle, remove)).toBe(true);
    await page.mouse.down();
    await page.mouse.up();
    await expect(rows.nth(2).locator("td").first()).toHaveText(next);
    await expect(rows.nth(2).locator(".selectedCell")).toHaveCount(2);
    await expect(table.locator(".selectedCell")).toHaveCount(2);
    await expect(menu).toBeVisible();
  }
  await expect(rows).toHaveCount(3);
  // Typing replaces the selected row's text.
  await page.keyboard.type("Z");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("Intro paragraph above the table.\n\n| Name | Notes |\n| ---- | ----- |\n| a1   | b1    |\n| Z    |       |\n");
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

test("a heading with the URL shown after its link continues on the next sheet at the chosen size", async () => {
  const file = path.join(directory, "linked-heading.md");
  await writeFile(file, "# [API](https://example.com/documentation/reference)\n");
  // On a small page at twice the size, the heading and its URL are taller than a page.
  await writeFile(path.join(directory, "profile", "settings.toml"), 'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nprintPaperSize = "a5"\nprintMargins = "wide"\nprintScalePercent = 200\n');
  await launch(file);
  await expect(page.locator(".milkdown .ProseMirror .md-link-url")).toHaveCount(1);
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-page").first()).toBeVisible();
  // The paginator breaks a heading between the lines of its text. Drawn as
  // generated content, the URL had none, so the heading was shrunk onto one sheet.
  await expect(page.locator(".print-fit")).toHaveCount(0);
  expect(await page.locator(".print-page").count()).toBeGreaterThan(1);
  const printed = await page.locator(".print-page .print-flow").allTextContents();
  expect(printed.join("")).toBe("API (https://example.com/d…umentation/reference)");
});

/**
 * A report of 36 short sections, each a heading and one to three paragraphs.
 * `under` gives the blocks that go between a section's heading and its text.
 */
function sectionReport(under: (section: number) => string[] = () => []): string {
  const words = "the quick brown fox jumps over a lazy dog while the editor keeps every line in place".split(" ");
  const sentence = (count: number, seed: number): string =>
    Array.from({ length: count }, (_, index) => words[(index * 7 + seed) % words.length]).join(" ");
  const blocks = ["# Quarterly report"];
  for (let section = 1; section <= 36; section++) {
    blocks.push(`## Section ${section}`, ...under(section));
    for (let paragraph = 0; paragraph <= section % 3; paragraph++) {
      blocks.push(`Body ${section}.${paragraph + 1}: ${sentence(18 + ((section * 13 + paragraph * 29) % 70), section + paragraph)}.`);
    }
    if (section % 5 === 0) blocks.push(`### Detail ${section}`, "- point one\n- point two");
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Open `file`, print it at A4 and then Letter, and expect no sheet but the
 * last to end with a heading, not counting the empty lines and rules under
 * it, and no sheet to hold only headings. Every character prints once, in
 * order, and every sheet holds its blocks. Returns how many empty lines and
 * rules the A4 sheets hold.
 */
async function expectHeadingsPrintedWithTheirText(file: string): Promise<number> {
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Quarterly report");
  const documentText = await page.locator(".milkdown .ProseMirror").evaluate((node) => node.textContent!.replace(/\s+/g, ""));
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeVisible();

  let blanks = 0;
  for (const [paper, widthPx] of [["a4", 794], ["letter", 816]] as const) {
    await page.getByLabel("Paper size", { exact: true }).selectOption(paper);
    // Each sheet's blocks, once the sheets are laid out on this paper.
    const read = () => page.locator(".print-page").evaluateAll((sheets, width) => {
      if (Math.round((sheets[0] as HTMLElement).offsetWidth) !== width) return null;
      return sheets.map((sheet) => {
        const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
        const flow = Array.from(sheet.querySelectorAll(".print-flow > *"));
        return {
          kinds: flow.map((block) => {
            if (/^H[1-6]$/.test(block.tagName)) return "heading";
            const blank = block.tagName === "HR" || (block.tagName === "P" && !block.textContent!.trim());
            return blank ? "blank" : "content";
          }),
          text: flow.map((block) => block.textContent).join("").replace(/\s+/g, ""),
          overflow: body.scrollHeight - body.clientHeight,
        };
      });
    }, widthPx);
    await expect.poll(read).not.toBeNull();
    const sheets = (await read())!;
    expect(sheets.length, paper).toBeGreaterThan(10);
    // No sheet but the last ends with a heading, and none holds only headings.
    const endsWithHeading = sheets
      .slice(0, -1)
      .flatMap((sheet, index) => (sheet.kinds.filter((kind) => kind !== "blank").at(-1) === "heading" ? [index + 1] : []));
    expect(endsWithHeading, `${paper}: sheets that end with a heading`).toEqual([]);
    for (const sheet of sheets) expect(sheet.kinds).toContain("content");
    // Every character prints once, in order, and every sheet holds its blocks.
    expect(sheets.map((sheet) => sheet.text).join("")).toBe(documentText);
    for (const sheet of sheets) expect(sheet.overflow).toBeLessThanOrEqual(0);
    if (paper === "a4") blanks = sheets.flatMap((sheet) => sheet.kinds).filter((kind) => kind === "blank").length;
  }
  return blanks;
}

test("a printed heading starts the next sheet with its text rather than ending a sheet", async () => {
  // The paginator measured height only, so at 7 of the 11 sheet breaks on A4
  // a heading fit at the foot of a sheet and its text started the next one.
  const file = path.join(directory, "sections.md");
  await writeFile(file, sectionReport());
  await expectHeadingsPrintedWithTheirText(file);
});

test("a printed heading with an empty line or a rule under it starts the next sheet with its text", async () => {
  // A heading went to the next sheet with the block after it, so one with an
  // empty line or a rule under it still ended a sheet, and its text started
  // the next one.
  const file = path.join(directory, "spaced-sections.md");
  await writeFile(file, sectionReport((section) => [
    ...(section % 3 === 1 ? ["<br />"] : section % 3 === 2 ? ["---"] : []),
    ...(section % 7 === 0 ? ["<br />", "<br />"] : []),
  ]));
  // The empty lines print as empty paragraphs and the rules as rules.
  expect(await expectHeadingsPrintedWithTheirText(file)).toBeGreaterThan(20);
});

test("the Markdown version continues a source line taller than a page on the next pages", async () => {
  const file = path.join(directory, "long-lines.md");
  // The nested quotes overflow the Markdown parser's stack, so the file prints as
  // Markdown. Both long lines wrap past a page: one breaks between characters,
  // the other between words.
  const quotes = ">".repeat(10_000) + " deep";
  const paragraph = Array.from({ length: 2_000 }, (_, index) => `word${index + 1}`).join(" ");
  const lines = ["Before", quotes, `${paragraph} END_MARKER`, "After"];
  await writeFile(file, lines.join("\n") + "\n");
  await launch(file);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-source").first()).toBeVisible();

  const sheets = await page.locator(".print-page").evaluateAll((pages) =>
    pages.map((sheet) => {
      const body = sheet.querySelector<HTMLElement>(".print-page-body")!;
      return {
        overflow: body.scrollHeight - body.clientHeight,
        text: Array.from(sheet.querySelectorAll(".print-flow > *"), (block) => block.textContent).join(""),
      };
    }),
  );
  // Each line printed as one block, and the page clipped what did not fit.
  for (const sheet of sheets) expect(sheet.overflow).toBeLessThanOrEqual(0);
  // Every character prints once, in order.
  expect(sheets.map((sheet) => sheet.text).join("")).toBe(lines.join(""));
  expect(sheets.length).toBeGreaterThan(lines.length);

  const pdf = path.join(directory, "long-lines.pdf");
  await chooseSave(pdf);
  await page.getByRole("button", { name: "Save as PDF", exact: true }).click();
  await expect(page.locator(".print-workspace")).toBeHidden({ timeout: 30_000 });
  // Every sheet reaches the PDF as a page of its own.
  const pages = (await readFile(pdf)).toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g);
  expect(pages).toHaveLength(sheets.length);
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

