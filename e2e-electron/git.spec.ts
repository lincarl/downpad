import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Upload and Get latest against real Git repositories: a bare remote, the
// clone that Downpad edits, and someone else's clone.

const projectRoot = path.resolve(import.meta.dirname, "..");
const NOTES = "# Notes\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
let directory: string;
let remote: string;
let mine: string;
let theirs: string;
let app: ElectronApplication | undefined;
let page: Page;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function clone(name: string, author: string): string {
  const folder = path.join(directory, name);
  git(directory, "clone", "--quiet", remote, folder);
  git(folder, "config", "user.name", author);
  git(folder, "config", "user.email", `${name}@example.com`);
  git(folder, "config", "commit.gpgsign", "false");
  return folder;
}

/** Commit and push a change to notes.md from someone else's clone. */
async function pushTheirs(text: string): Promise<void> {
  git(theirs, "pull", "--quiet", "--ff-only");
  await writeFile(path.join(theirs, "notes.md"), text);
  git(theirs, "commit", "--quiet", "-am", "Their change");
  git(theirs, "push", "--quiet");
}

test.beforeEach(async () => {
  const temporaryRoot = path.join(projectRoot, "dev-temp", "electron-e2e");
  await mkdir(temporaryRoot, { recursive: true });
  directory = await mkdtemp(path.join(temporaryRoot, "git-"));
  remote = path.join(directory, "remote.git");
  git(directory, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = clone("seed", "Seed");
  await writeFile(path.join(seed, "notes.md"), NOTES);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "Start");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  mine = clone("mine", "Me");
  theirs = clone("theirs", "Anna Berg");
  const profile = path.join(directory, "profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\n");
});

test.afterEach(async ({}, testInfo) => {
  if (app) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    }).catch(() => {});
    await app.close();
  }
  app = undefined;
  if (testInfo.status === testInfo.expectedStatus) await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

/** Launch Downpad with `file`. `beforeStart` runs once the window exists,
 *  before the app has started in it. */
async function launch(file: string, beforeStart?: () => Promise<void>): Promise<void> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[0] !== "DOWNPAD_DEV_URL"),
  );
  const executablePath = process.env.DOWNPAD_EXECUTABLE;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath,
    cwd: projectRoot,
    args: [...(executablePath ? [] : [path.join(projectRoot, "electron-dist", "main.js")]), file],
    env: { ...environment, DOWNPAD_USER_DATA_DIR: path.join(directory, "profile") },
  });
  page = await app.firstWindow();
  await beforeStart?.();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
}

/** The document view of the active tab. Other tabs keep hidden editors. */
const shownDocument = () => page.locator(".editor-pane:not([hidden]) .milkdown");
const uploadButton = () => page.locator(".toolbar-upload").getByRole("button", { name: "Upload", exact: true });
const status = () => page.locator(".status-git");

test("offers Upload only for a document in a repository", async () => {
  const loose = path.join(directory, "loose.md");
  await writeFile(loose, "# Loose\n");
  await launch(loose);
  await expect(shownDocument().locator("h1")).toHaveText("Loose");
  await expect(page.locator(".toolbar-upload")).toHaveCount(0);
  await expect(status()).toHaveCount(0);
});

test("gets someone else's change to a document without asking", async () => {
  await pushTheirs(NOTES.replace("First paragraph.", "Their first paragraph."));
  await launch(path.join(mine, "notes.md"));
  await expect(shownDocument()).toContainText("Their first paragraph.");
  await expect(status()).toHaveText("Up to date");
  await expect(page.locator(".banner")).toBeHidden();
});

test("gets someone else's change while the Recent view shows, and stays on that view", async () => {
  // A document long enough to scroll, which both clones have.
  const long = `${NOTES}\n${Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1}.\n`).join("\n")}`;
  await pushTheirs(long);
  git(mine, "pull", "--quiet", "--ff-only");
  await pushTheirs(long.replace("First paragraph.", "Their first paragraph."));
  // Hold Get latest until released. Electron keeps the handlers of
  // ipcMain.handle in `_invokeHandlers`, and a handler on the window's own
  // `ipc` runs in their place.
  await launch(path.join(mine, "notes.md"), () => app!.evaluate(({ BrowserWindow, ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const invoke = (Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler>).get("downpad:invoke")!;
    const released = new Promise((resolve) => Reflect.set(globalThis, "releaseGetLatest", resolve));
    BrowserWindow.getAllWindows()[0]!.webContents.ipc.handle("downpad:invoke", async (event, command, ...args) => {
      if (command === "git_get_latest") {
        Reflect.set(globalThis, "getLatestHeld", true);
        await released;
      }
      return invoke(event, command, ...args);
    });
  }));
  await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, "getLatestHeld") === true)).toBe(true);
  // Both panes of the Split layout scroll on their own.
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const paneTops = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")].map((pane) => pane.scrollTop));
  await expect.poll(async () => (await paneTops()).length).toBe(2);
  await page.evaluate(() => {
    for (const pane of document.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")) pane.scrollTop = 600;
  });
  expect(await paneTops()).toEqual([600, 600]);
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  const recent = page.locator(".recent-name").first();
  await expect(recent).toBeVisible();
  await app!.evaluate(() => (Reflect.get(globalThis, "releaseGetLatest") as () => void)());
  // The document takes their change behind the Recent view, which stays in front.
  await expect(page.locator(".milkdown").first()).toContainText("Their first paragraph.");
  await expect(recent).toBeVisible();
  await page.getByRole("tab", { name: /notes\.md/ }).click();
  await expect(shownDocument()).toContainText("Their first paragraph.");
  await expect(status()).toHaveText("Up to date");
  // Its new editors are where the old ones were scrolled.
  await expect.poll(paneTops).toEqual([600, 600]);
});

test("uploads typed changes", async () => {
  await launch(path.join(mine, "notes.md"));
  await expect(uploadButton()).toBeVisible();
  await expect(status()).toHaveText("Up to date");
  await page.locator(".milkdown p", { hasText: "Third paragraph." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Added.");
  await expect(status()).toHaveText("Not uploaded");
  await uploadButton().click();
  await expect(status()).toHaveText("Up to date");
  expect(git(remote, "log", "-1", "--format=%s %an", "main")).toBe("Update notes.md Me\n");
  expect(git(remote, "show", "main:notes.md")).toContain("Third paragraph. Added.");
});

test("offers to combine changes to other parts, and combines them", async () => {
  await writeFile(path.join(mine, "notes.md"), NOTES.replace("Third paragraph.", "My third paragraph."));
  await pushTheirs(NOTES.replace("First paragraph.", "Their first paragraph."));
  await launch(path.join(mine, "notes.md"));
  const banner = page.locator(".banner");
  await expect(banner).toContainText("Anna Berg changed this document");
  await banner.getByRole("button", { name: "Get latest" }).click();
  await expect(banner).toContainText("Downpad combined Anna Berg's changes with yours.");
  await expect(shownDocument()).toContainText("Their first paragraph.");
  await expect(shownDocument()).toContainText("My third paragraph.");
  expect(await readFile(path.join(mine, "notes.md"), "utf8")).toBe(
    NOTES.replace("First paragraph.", "Their first paragraph.").replace("Third paragraph.", "My third paragraph."),
  );
});

test("asks about changes to the same parts, and discards the user's on request", async () => {
  await writeFile(path.join(mine, "notes.md"), NOTES.replace("Second paragraph.", "My second paragraph."));
  await pushTheirs(NOTES.replace("Second paragraph.", "Their second paragraph."));
  await launch(path.join(mine, "notes.md"));
  const dialog = page.getByRole("dialog", { name: "Someone else changed this document" });
  await expect(dialog).toContainText("Anna Berg changed “notes.md”");
  await dialog.getByRole("button", { name: "Discard my changes" }).click();
  await expect(shownDocument()).toContainText("Their second paragraph.");
  const banner = page.locator(".banner");
  await expect(banner).toContainText("Your changes to “notes.md” are discarded");
  await banner.getByRole("button", { name: "Open copy" }).click();
  await expect(shownDocument()).toContainText("My second paragraph.");
  expect(git(mine, "status", "--porcelain")).toBe("");
});

test("saves the user's version as a new file when the changes overlap", async () => {
  await writeFile(path.join(mine, "notes.md"), NOTES.replace("Second paragraph.", "My second paragraph."));
  await pushTheirs(NOTES.replace("Second paragraph.", "Their second paragraph."));
  const mineAs = path.join(mine, "notes (my version).md");
  await launch(path.join(mine, "notes.md"));
  await app!.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, mineAs);
  await page.getByRole("dialog").getByRole("button", { name: "Save mine as…" }).click();
  await expect(page.locator(".banner")).toContainText("Your version is saved as “notes (my version).md”");
  await expect(page.getByRole("tab", { name: "notes (my version).md" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "notes.md", exact: true })).toBeVisible();
  expect(await readFile(mineAs, "utf8")).toContain("My second paragraph.");
  expect(await readFile(path.join(mine, "notes.md"), "utf8")).toContain("Their second paragraph.");
});

test("uploads on each save when Upload when saving is on", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\ngitUploadOnSave = true\n");
  await launch(path.join(mine, "notes.md"));
  await expect(status()).toHaveText("Up to date");
  await page.locator(".milkdown p", { hasText: "First paragraph." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Saved.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => git(remote, "show", "main:notes.md")).toContain("First paragraph. Saved.");
  await expect(status()).toHaveText("Up to date");
});

test("turns Git off from its settings page and keeps file saving and preferences", async () => {
  await launch(path.join(mine, "notes.md"));
  await expect(status()).toHaveText("Up to date");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  let settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("checkbox", { name: "Enable Git" })).toBeHidden();
  await settings.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "Enable Git" })).toBeChecked();
  await settings.getByRole("checkbox", { name: "Upload when saving" }).check();
  await settings.getByRole("checkbox", { name: "Enable Git" }).uncheck();
  await expect(settings.getByRole("checkbox", { name: "Get latest automatically" })).toBeDisabled();
  await expect(settings.getByRole("checkbox", { name: "Upload when saving" })).toBeDisabled();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(".toolbar-upload")).toHaveCount(0);
  await expect(status()).toHaveCount(0);

  await shownDocument().locator("p", { hasText: "Third paragraph." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Saved locally.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(path.join(mine, "notes.md"), "utf8")).toContain("Saved locally.");
  expect(git(remote, "show", "main:notes.md")).toBe(NOTES);

  await app!.close();
  app = undefined;
  await launch(path.join(mine, "notes.md"));
  settings = page.getByRole("dialog", { name: "Settings" });
  await expect(page.locator(".toolbar-upload")).toHaveCount(0);
  await expect(status()).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "Enable Git" })).not.toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "Upload when saving" })).toBeChecked();
  await settings.getByRole("checkbox", { name: "Enable Git" }).check();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(uploadButton()).toBeVisible();
  await expect(status()).toHaveText("Not uploaded");
  expect(git(remote, "show", "main:notes.md")).toBe(NOTES);
});

test("blocks Git requests while disabled and resumes checks when enabled", async () => {
  await writeFile(path.join(directory, "profile", "settings.toml"), "hasSeenWelcome = true\nhasCheckedDefaultHandler = true\ngitEnabled = false\n");
  await pushTheirs(NOTES.replace("First paragraph.", "Their first paragraph."));
  const file = path.join(mine, "notes.md");
  const original = await readFile(file);
  await launch(file);
  await expect(shownDocument()).toContainText("First paragraph.");
  await expect(page.locator(".toolbar-upload")).toHaveCount(0);
  expect(await page.evaluate((path) => window.downpadDesktop!.invoke("git_status", { path, fetch: true }), file)).toBeNull();
  const errors = await page.evaluate(async (path) => {
    const bridge = window.downpadDesktop!;
    const requests = [
      bridge.invoke("git_get_latest", { path, openFiles: [], interactive: true }),
      bridge.invoke("git_upload", { path, openFiles: [] }),
      bridge.invoke("git_discard", { path, openFiles: [] }),
      bridge.invoke("git_preview_combine", { path, markdown: "" }),
    ];
    return Promise.all(requests.map((request) => request.then(() => "unexpected success", (error: unknown) => String(error))));
  }, file);
  for (const error of errors) expect(error).toContain("Git is turned off. Enable it in Settings > Git");
  await expect(readFile(path.join(mine, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(file)).toEqual(original);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Git", exact: true }).click();
  await settings.getByRole("checkbox", { name: "Enable Git" }).check();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(shownDocument()).toContainText("Their first paragraph.");
  await expect(status()).toHaveText("Up to date");
});
