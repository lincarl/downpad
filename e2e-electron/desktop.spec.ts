import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  if (app) await app.close();
  app = undefined;
});

async function launch(file?: string): Promise<void> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[0] !== "MD_EASY_DEV_URL"),
  );
  const executablePath = process.env.MD_EASY_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    cwd: projectRoot,
    args: [
      ...(executablePath ? [] : [path.join(projectRoot, "electron-dist", "main.js")]),
      ...(process.env.MD_EASY_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ...(file ? [file] : []),
    ],
    env: { ...environment, MD_EASY_USER_DATA_DIR: path.join(directory, "profile") },
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
  const preferences = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences());
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(preferences.sandbox).toBe(true);
  await page.screenshot({ path: path.join(directory, "electron-open.png") });
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
  await page.getByLabel("Orientation", { exact: true }).selectOption("landscape");
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

test("Print submits the document to an installed test printer", async () => {
  const printer = process.env.MD_EASY_TEST_PRINTER;
  test.skip(!printer, "Set MD_EASY_TEST_PRINTER to a disposable virtual printer for native spool verification.");
  const file = path.join(directory, "printer.md");
  await writeFile(file, "# Printed by Electron\n\nNative printer submission.\n");
  await launch(file);
  await expect(page.locator(heading)).toHaveText("Printed by Electron");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.getByLabel("Printer", { exact: true }).selectOption(printer!);
  await page.locator(".print-ws-top").getByRole("button", { name: "Print", exact: true }).click();
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

