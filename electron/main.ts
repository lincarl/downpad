import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, shell, systemPreferences,
  type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions,
} from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DesktopEventPayloads, HistoryCommand } from "../src/ipc/bridge";
import type { DefaultHandler } from "../src/ipc/contracts";
import { absolutePath, ensureAttachmentsDirectory, exists, imageMime, readImage, readMarkdown, writeAttachment, writeMarkdown } from "./io";
import { historyItems, macApplicationMenu } from "./menus";
import { PrintService, validatePrintOptions } from "./printing";
import { clipboardPermission, developmentEntryUrl, externalUrl, ImageAccess, trustedPage } from "./security";
import { ConfigStore, RecentSearch, statFiles } from "./storage";
import { watchPath } from "./watchers";

app.setName("md-easy");
const isolatedData = process.env.MD_EASY_USER_DATA_DIR;
if (isolatedData) {
  const directory = absolutePath(isolatedData);
  mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "md-easy-file", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const developmentUrl = developmentEntryUrl(process.env.MD_EASY_DEV_URL, app.isPackaged);
const entryUrl = developmentUrl ?? pathToFileURL(join(appRoot, "dist", "index.html")).href;
const config = new ConfigStore(app.getPath("userData"));
const imageAccess = new ImageAccess();
const searches = new RecentSearch();
let mainWindow: BrowserWindow | null = null;
let printing: PrintService | null = null;
let unwatchDocument: (() => void) | undefined;
let unwatchSettings: (() => void) | undefined;
let closeListenerAttached = false;
let openListenerAttached = false;
let allowClose = false;
let startupCompleted = false;
let quitRequested = false;

function firstFileArgument(argv: string[], cwd = process.cwd()): string | null {
  for (const argument of argv.slice(app.isPackaged ? 1 : 2)) {
    if (argument.startsWith("-")) continue;
    const candidate = resolve(cwd, argument);
    if ([".md", ".markdown", ".mdown", ".mkd", ".txt"].includes(extname(candidate).toLowerCase())) return candidate;
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* Ignore non-file launcher arguments. */ }
  }
  return null;
}

const initialLaunchPath = firstFileArgument(process.argv);
const pendingOpenPaths: string[] = initialLaunchPath ? [initialLaunchPath] : [];

function emit<K extends keyof DesktopEventPayloads>(event: K, payload: DesktopEventPayloads[K]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    mainWindow.webContents.send(`md-easy:event:${event}`, payload);
  }
}

/** Ask the renderer to run Undo or Redo, chosen in a native menu, in what has
 *  the focus. */
function requestHistory(command: HistoryCommand): void {
  emit("history-requested", command);
}

function requestOpen(path: string): void {
  const target = absolutePath(path);
  if (mainWindow && openListenerAttached && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    emit("open-file-requested", { path: target });
  }
  else pendingOpenPaths.push(target);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (startupCompleted) {
    void createWindow().catch((error: unknown) => console.error("md-easy could not reopen its window", error));
  }
}

app.on("open-file", (event, path) => { event.preventDefault(); requestOpen(path); });
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const path = firstFileArgument(argv, cwd);
    if (path) requestOpen(path);
    else if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  void start().catch((error: unknown) => {
    console.error("md-easy could not start", error);
    dialog.showErrorBox("md-easy could not start", error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

function trustedSender(event: Pick<IpcMainInvokeEvent | IpcMainEvent, "sender" | "senderFrame">): void {
  const window = mainWindow;
  if (!window || event.sender !== window.webContents || !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame || !trustedPage(event.senderFrame.url, entryUrl)) {
    throw new Error("The desktop request came from an untrusted page.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop arguments must be an object.");
  return value as Record<string, unknown>;
}

function string(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`The ${key} argument must be text.`);
  return value;
}

function number(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The ${key} argument must be a number.`);
  return value;
}

function boolean(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new Error(`The ${key} argument must be true or false.`);
  return value;
}

function path(source: Record<string, unknown>, key = "path"): string { return absolutePath(string(source, key)); }

async function invoke(command: unknown, value: unknown): Promise<unknown> {
  const args = record(value);
  switch (command) {
    case "read_file": {
      const target = path(args);
      const payload = await readMarkdown(target);
      return payload;
    }
    case "write_file": {
      const eol = string(args, "eol");
      if (eol !== "lf" && eol !== "crlf") throw new Error("Unsupported line ending.");
      const target = path(args);
      const meta = await writeMarkdown(target, string(args, "content"), eol);
      return meta;
    }
    case "path_exists": return exists(path(args));
    case "watch_file": {
      const target = path(args);
      unwatchDocument?.();
      unwatchDocument = watchPath(target, (modifiedMs) => emit("file-changed", { path: target, modifiedMs }));
      return;
    }
    case "unwatch_file": unwatchDocument?.(); unwatchDocument = undefined; return;
    case "ensure_attachments_dir": return ensureAttachmentsDirectory(path(args, "docPath"), string(args, "folderName"));
    case "write_attachment": {
      const bytes = args.bytes;
      if (!(bytes instanceof Uint8Array)) throw new Error("Attachment bytes must be a Uint8Array.");
      return writeAttachment(path(args, "docPath"), string(args, "folderName"), string(args, "fileName"), bytes);
    }
    case "read_image_bytes": return readImage(path(args));
    case "load_settings": return config.settings();
    case "save_settings": return config.saveSettings(args.settings);
    case "settings_path": return config.settingsPath;
    case "get_recent_files": return config.recent(args.limit === null || args.limit === undefined ? undefined : number(args, "limit"));
    case "record_file_opened": return config.recordOpened(path(args), number(args, "openedAtMs"));
    case "remove_recent": return config.removeRecent(path(args));
    case "set_favorite": return config.setFavorite(path(args), boolean(args, "favorite"));
    case "stat_files": {
      if (!Array.isArray(args.paths) || !args.paths.every((item: unknown) => typeof item === "string")) throw new Error("File paths must be a list of strings.");
      return statFiles(args.paths as string[]);
    }
    case "search_recent_contents": {
      const searchId = string(args, "searchId");
      const opts = record(args.opts);
      return searches.run(searchId, (await config.recent()).map((row) => row.path), string(args, "query"), boolean(opts, "caseSensitive"),
        (hit) => emit("search-result", { searchId, hit }));
    }
    case "cancel_search": searches.cancel(string(args, "searchId")); return;
    case "write_snapshot": return config.writeSnapshot(args.snapshot);
    case "delete_snapshot": return config.deleteSnapshot(string(args, "sessionId"));
    case "list_recovery_snapshots": return config.snapshots();
    case "get_launch_args": return pendingOpenPaths.shift() ?? null;
    case "get_default_md_handler": return defaultMdHandler();
    case "open_default_apps_settings": {
      if (process.platform !== "win32") throw new Error("Choose md-easy in your file manager's Open with settings.");
      return shell.openExternal("ms-settings:defaultapps");
    }
    case "get_system_accent_color": {
      try { return process.platform === "win32" || process.platform === "darwin" ? `#${systemPreferences.getAccentColor().slice(0, 6)}` : null; }
      catch { return null; }
    }
    case "list_printers": {
      if (!mainWindow) throw new Error("The window is unavailable.");
      const defaultName = await defaultPrinterName();
      return (await mainWindow.webContents.getPrintersAsync()).map((printer) => ({ name: printer.name, isDefault: printer.name === defaultName }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
    }
    case "print_webview":
    case "print_webview_to_pdf": {
      if (!printing) throw new Error("The print service is unavailable.");
      printing.start(validatePrintOptions(args.options), command === "print_webview_to_pdf" ? path(args) : undefined);
      return;
    }
    default: throw new Error("Unknown desktop command.");
  }
}

const executeFile = promisify(execFile);

async function defaultPrinterName(): Promise<string> {
  try {
    if (process.platform === "win32") {
      const result = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1).Name"], { timeout: 5000, windowsHide: true });
      return result.stdout.trim();
    }
    const result = await executeFile("lpstat", ["-d"], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    return /:\s*([^\r\n]+)$/.exec(result.stdout.trim())?.[1]?.trim() ?? "";
  } catch { return ""; }
}

async function registryValue(key: string, value?: string): Promise<string> {
  try {
    const result = await executeFile("reg.exe", ["query", key, ...(value ? ["/v", value] : ["/ve"])], { timeout: 5000, windowsHide: true });
    return /\sREG_SZ\s+([^\r\n]+)/.exec(result.stdout)?.[1]?.trim() ?? "";
  } catch { return ""; }
}

async function defaultMdHandler(): Promise<DefaultHandler> {
  if (process.platform !== "win32") return { progId: "", isDefault: false };
  const progId = await registryValue("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice", "ProgId");
  const command = await registryValue(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`) ||
    await registryValue(`HKCR\\${progId}\\shell\\open\\command`);
  const executable = command.startsWith('"') ? command.slice(1).split('"')[0] ?? "" : /^(.*?\.exe)/i.exec(command)?.[1] ?? "";
  const normalized = executable.replace(/\\/g, "/").toLowerCase();
  return { progId, isDefault: normalized === process.execPath.replace(/\\/g, "/").toLowerCase() || /(?:^|\/)md-easy\.exe$/i.test(normalized) || /md[-_]easy/i.test(progId) };
}

function filters(source: Record<string, unknown>): Electron.FileFilter[] | undefined {
  if (source.filters === undefined) return undefined;
  if (!Array.isArray(source.filters)) throw new Error("File filters must be a list.");
  return source.filters.map((value: unknown) => {
    const filter = record(value);
    if (!Array.isArray(filter.extensions) || !filter.extensions.every((item: unknown) => typeof item === "string" && /^(?:\*|[a-zA-Z0-9]+)$/.test(item))) {
      throw new Error("A file filter contains an invalid extension.");
    }
    return { name: string(filter, "name"), extensions: filter.extensions as string[] };
  });
}

function dialogOptions(value: unknown): Pick<OpenDialogOptions & SaveDialogOptions, "title" | "defaultPath" | "filters"> {
  const source = record(value);
  return {
    title: source.title === undefined ? undefined : string(source, "title"),
    defaultPath: source.defaultPath === undefined ? undefined : string(source, "defaultPath"),
    filters: filters(source),
  };
}

function registerIpc(): void {
  ipcMain.handle("md-easy:invoke", (event, command: unknown, args: unknown) => { trustedSender(event); return invoke(command, args); });
  ipcMain.handle("md-easy:dialog-open", async (event, value: unknown) => {
    trustedSender(event);
    const options = record(value);
    const multiple = options.multiple === undefined ? false : boolean(options, "multiple");
    const result = await dialog.showOpenDialog(mainWindow!, { ...dialogOptions(value), properties: ["openFile", ...(multiple ? ["multiSelections" as const] : [])] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return multiple ? result.filePaths : result.filePaths[0];
  });
  ipcMain.handle("md-easy:dialog-save", async (event, value: unknown) => {
    trustedSender(event);
    const result = await dialog.showSaveDialog(mainWindow!, { ...dialogOptions(value), properties: ["showOverwriteConfirmation", "createDirectory"] });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });
  ipcMain.handle("md-easy:dialog-ask", async (event, message: unknown, value: unknown) => {
    trustedSender(event);
    if (typeof message !== "string") throw new Error("A dialog message is required.");
    const options = record(value);
    const kind = options.kind ?? "question";
    if (kind !== "question" && kind !== "info" && kind !== "warning" && kind !== "error") throw new Error("Unknown dialog type.");
    const result = await dialog.showMessageBox(mainWindow!, {
      type: kind, title: options.title === undefined ? "md-easy" : string(options, "title"), message,
      buttons: [options.cancelLabel === undefined ? "Cancel" : string(options, "cancelLabel"), options.okLabel === undefined ? "OK" : string(options, "okLabel")],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  });
  ipcMain.handle("md-easy:open-external", (event, url: unknown) => { trustedSender(event); return shell.openExternal(externalUrl(url)); });
  ipcMain.handle("md-easy:image-url", (event, imagePath: unknown) => { trustedSender(event); return imageAccess.imageUrl(imagePath); });
  ipcMain.handle("md-easy:reveal-item", (event, target: unknown) => { trustedSender(event); shell.showItemInFolder(absolutePath(target)); });
  ipcMain.handle("md-easy:set-theme", (event, theme: unknown) => {
    trustedSender(event);
    if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("Unknown window theme.");
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("md-easy:close-window", (event) => {
    trustedSender(event);
    allowClose = true;
    if (quitRequested) app.quit(); else mainWindow?.close();
  });
  ipcMain.handle("md-easy:cancel-window-close", (event) => { trustedSender(event); quitRequested = false; });
  ipcMain.on("md-easy:close-listener", (event, attached: unknown) => {
    try { trustedSender(event); closeListenerAttached = attached === true; } catch { /* Ignore untrusted listener registration. */ }
  });
  ipcMain.on("md-easy:open-listener", (event, attached: unknown) => {
    try {
      trustedSender(event);
      openListenerAttached = attached === true;
      if (openListenerAttached) {
        for (const requested of pendingOpenPaths.splice(0)) emit("open-file-requested", { path: requested });
      }
    } catch { /* Ignore untrusted listener registration. */ }
  });
}

interface WindowState { width: number; height: number; x?: number; y?: number; maximized?: boolean }

function loadWindowState(): WindowState {
  try {
    const value = record(JSON.parse(readFileSync(join(config.directory, "window-state.json"), "utf8")) as unknown);
    const width = number(value, "width");
    const height = number(value, "height");
    if (width < 480 || height < 360) throw new Error("Invalid window size.");
    const state: WindowState = { width, height, maximized: value.maximized === true };
    if (typeof value.x === "number" && typeof value.y === "number") {
      const bounds = { x: value.x, y: value.y, width, height };
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x &&
        bounds.y < workArea.y + workArea.height && bounds.y + 40 > workArea.y);
      if (visible) { state.x = value.x; state.y = value.y; }
    }
    return state;
  } catch { return { width: 1000, height: 720 }; }
}

function saveWindowState(window: BrowserWindow): void {
  const destination = join(config.directory, "window-state.json");
  const temporary = `${destination}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
    renameSync(temporary, destination);
  } catch (error) { console.error("md-easy could not save window geometry", error); }
}

async function createWindow(): Promise<void> {
  if (mainWindow) return;
  allowClose = false;
  closeListenerAttached = false;
  openListenerAttached = false;
  const state = loadWindowState();
  const icon = join(appRoot, "build", "icon.png");
  const window = new BrowserWindow({
    ...state, title: "md-easy", minWidth: 480, minHeight: 360,
    // Nord window chrome, the default dark theme, until the renderer paints.
    backgroundColor: "#2e3440", show: false, autoHideMenuBar: true,
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: join(appRoot, "electron-dist", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow = window;
  printing = new PrintService(window, (result) => emit("print-completed", result));
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(externalUrl(url)).catch((error: unknown) => console.error("md-easy could not open link", error)); }
    catch { /* Reject unsupported links without creating a new window. */ }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedPage(url, entryUrl)) {
      event.preventDefault();
      try { void shell.openExternal(externalUrl(url)).catch(() => {}); } catch { /* Reject unsupported navigation targets. */ }
    }
  });
  window.webContents.on("will-redirect", (event, url) => { if (!trustedPage(url, entryUrl)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => { event.preventDefault(); });
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const items: Electron.MenuItemConstructorOptions[] = params.dictionarySuggestions.slice(0, 6).map((suggestion) => ({
      label: suggestion, click: () => window.webContents.replaceMisspelling(suggestion),
    }));
    if (params.misspelledWord) {
      items.push({ label: "Add to dictionary", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: "separator" });
    }
    // Undo and Redo run the focused editor's own history (menus.ts).
    items.push(...historyItems(requestHistory, process.platform), { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && clipboardPermission(permission, details.requestingUrl, entryUrl, details.isMainFrame));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window.webContents && clipboardPermission(permission, details.requestingUrl ?? "", entryUrl, details.isMainFrame));
  window.on("close", (event) => {
    if (!allowClose && closeListenerAttached && !window.webContents.isDestroyed() && !window.webContents.isCrashed()) {
      event.preventDefault();
      emit("close-requested", undefined);
    } else saveWindowState(window);
  });
  // Subscriptions belong to the current renderer, which disappears on reload
  // or crash. Keep new file requests queued until the replacement subscribes.
  const resetRendererListeners = (): void => {
    closeListenerAttached = false;
    openListenerAttached = false;
  };
  window.webContents.on("render-process-gone", resetRendererListeners);
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) resetRendererListeners();
  });
  window.on("closed", () => {
    unwatchDocument?.(); unwatchDocument = undefined;
    mainWindow = null; printing = null; closeListenerAttached = false; openListenerAttached = false;
  });
  window.once("ready-to-show", () => { if (state.maximized) window.maximize(); window.show(); });
  window.webContents.on("preload-error", (_event, preloadPath, error) => { console.error("md-easy preload failed", preloadPath, error); });
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(appRoot, "dist", "index.html"));
}

async function start(): Promise<void> {
  await app.whenReady();
  await config.initialize();
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate(macApplicationMenu(requestHistory)) : null);
  registerIpc();
  protocol.handle("md-easy-file", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local" || url.pathname !== "/image") return new Response("Not found", { status: 404 });
      const path = await imageAccess.resolveImage(url.searchParams.get("token") ?? "");
      const bytes = await readFile(path);
      return new Response(new Uint8Array(bytes), { headers: {
        "Content-Type": imageMime(path) ?? "application/octet-stream", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Access-Control-Allow-Origin": new URL(entryUrl).origin,
      } });
    } catch { return new Response("Image unavailable", { status: 403 }); }
  });
  unwatchSettings = watchPath(config.settingsPath, () => { void config.settings().then((settings) => emit("settings-changed", settings)); });
  await createWindow();
  startupCompleted = true;
  app.on("activate", () => { if (!mainWindow) void createWindow(); });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { quitRequested = true; });
app.on("will-quit", () => { unwatchDocument?.(); unwatchSettings?.(); });
