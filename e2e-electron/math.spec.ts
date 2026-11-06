import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
let directory: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(async () => {
  const temporaryRoot = path.join(projectRoot, "dev-temp", "electron-math");
  await mkdir(temporaryRoot, { recursive: true });
  directory = await mkdtemp(path.join(temporaryRoot, "run-"));
  await mkdir(path.join(directory, "profile"));
  await writeFile(path.join(directory, "profile", "settings.toml"),
    "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckEnabled = false\n");
});

test.afterEach(async ({}, testInfo) => {
  await close();
  if (testInfo.status === testInfo.expectedStatus) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});

/** Open the built desktop app and a synthetic file using only its test profile. */
async function launch(file: string): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !["ELECTRON_RUN_AS_NODE", "DOWNPAD_DEV_URL"].includes(entry[0]),
  ));
  const executablePath = process.env.DOWNPAD_EXECUTABLE;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath,
    cwd: projectRoot,
    args: [...(executablePath ? [] : [path.join(projectRoot, "electron-dist", "main.js")]), file],
    env: { ...environment, DOWNPAD_USER_DATA_DIR: path.join(directory, "profile") },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
}

/** Close this test's app without leaving an unsaved-changes prompt open. */
async function close(): Promise<void> {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  }).catch(() => {});
  await app.close();
  app = undefined;
}

test("the built equation editor works offline and saves inline and display LaTeX through a restart", async () => {
  const file = path.join(directory, "equations.md");
  const unusual = "\\custommacro{  x  } + \\frac{1}{2}";
  const original = `Inline $a$ stays inline.\n\n$$\n${unusual}\n$$\n`;
  await writeFile(file, original);
  await launch(file);
  expect(page.url()).toMatch(/^file:/);
  await page.context().setOffline(true);
  const networkRequests: string[] = [];
  const failedResources: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) networkRequests.push(request.url());
  });
  page.on("requestfailed", (request) => failedResources.push(request.url()));
  await page.evaluate(() => {
    const violations: string[] = [];
    Reflect.set(window, "mathCspViolations", violations);
    window.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });

  const display = page.locator(".editor-pane-wysiwyg .milkdown-code-block");
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  const source = dialog.getByRole("textbox", { name: "LaTeX source", exact: true });
  await display.getByRole("button", { name: "Edit equation", exact: true }).click();
  await expect(source).toHaveValue(unusual);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(original);

  const formula = page.locator('.editor-pane-wysiwyg [data-type="math_inline"]');
  await formula.click();
  await dialog.locator("math-field").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("x/y");
  await expect(source).toHaveValue("\\frac{x}{y}");
  await expect(dialog.locator("math-field .ML__frac-line")).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((font) => font.family === "KaTeX_Math").map((font) => font.status);
  });
  // Chromium omits file resources from Resource Timing, so inspect the loaded
  // font faces while the built file page has networking disabled.
  expect(fonts).toContain("loaded");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();

  const matrix = "\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}";
  await display.getByRole("button", { name: "Edit equation", exact: true }).click();
  await source.fill(matrix);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(display.locator(".preview .katex .mtable")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  const saved = `Inline $\\frac{x}{y}$ stays inline.\n\n$$\n${matrix}\n$$\n`;
  await expect.poll(() => readFile(file, "utf8")).toBe(saved);
  expect(networkRequests).toEqual([]);
  expect(failedResources).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, "mathCspViolations"))).toEqual([]);

  await close();
  await launch(file);
  await expect(page.locator('.editor-pane-wysiwyg [data-type="math_inline"]')).toHaveAttribute("data-value", "\\frac{x}{y}");
  const reopenedDisplay = page.locator(".editor-pane-wysiwyg .milkdown-code-block");
  await expect(reopenedDisplay.locator(".preview .katex .mtable")).toBeVisible();
  await reopenedDisplay.getByRole("button", { name: "Edit equation", exact: true }).click();
  const reopenedDialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  await expect(reopenedDialog.getByRole("textbox", { name: "LaTeX source", exact: true })).toHaveValue(matrix);
  await reopenedDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readFile(file, "utf8")).toBe(saved);
});

test("native Undo and Redo edit the visual equation draft without changing the document", async () => {
  const file = path.join(directory, "equation-history.md");
  const original = "Inline $a$ stays inline.\n";
  await writeFile(file, original);
  await launch(file);
  await app!.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      Reflect.set(globalThis, "shownMenu", this);
    };
  });

  const formula = page.locator('.editor-pane-wysiwyg [data-type="math_inline"]');
  await formula.click();
  const dialog = page.getByRole("dialog", { name: "Edit equation", exact: true });
  const field = dialog.locator("math-field");
  const source = dialog.getByRole("textbox", { name: "LaTeX source", exact: true });
  await field.click();
  await expect(field).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type("b");
  await expect(source).toHaveValue("ab");

  /** Choose an actual native menu item while keeping the equation focused. */
  const choose = async (label: string): Promise<void> => {
    await app!.evaluate(() => Reflect.set(globalThis, "shownMenu", null));
    await field.click({ button: "right", modifiers: ["Shift"] });
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "shownMenu") !== null)).toBe(true);
    const enabled = await app!.evaluate(({ BrowserWindow }, wanted) => {
      const menu: Electron.Menu = Reflect.get(globalThis, "shownMenu");
      const item = menu.items.find((entry) => entry.label === wanted);
      if (!item?.enabled) return false;
      const window = BrowserWindow.getAllWindows()[0]!;
      item.click(undefined, window, window.webContents);
      return true;
    }, label);
    expect(enabled).toBe(true);
  };

  await choose("Undo");
  await expect(source).toHaveValue("a");
  await choose("Redo");
  await expect(source).toHaveValue("ab");
  await expect(formula).toHaveAttribute("data-value", "a");
  expect(await readFile(file, "utf8")).toBe(original);

  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(formula).toHaveAttribute("data-value", "ab");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(formula).toHaveAttribute("data-value", "a");
});
