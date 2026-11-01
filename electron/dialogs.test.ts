import { contextBridge, ipcRenderer, nativeTheme, webUtils, type IpcMainInvokeEvent, type MessageBoxOptions } from "electron";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopEventPayloads, ElectronBridge } from "../src/ipc/bridge";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type Listener = (...args: unknown[]) => unknown;
type MenuTemplate = { label?: string; click?: () => void }[];

const native = vi.hoisted(() => {
  // Vitest clears mock calls before each test, so registered callbacks are kept in maps.
  const webContentsEvents = new Map<string, Listener>();
  const windowEvents = new Map<string, Listener>();
  const callbacks: { windowOpen?: Listener; permissionRequest?: Listener; permissionCheck?: Listener } = {};
  const window = {
    webContents: {
      mainFrame: { url: "" },
      setWindowOpenHandler: (handler: Listener) => { callbacks.windowOpen = handler; },
      on: (event: string, listener: Listener) => { webContentsEvents.set(event, listener); },
      send: vi.fn(),
      isDestroyed: () => false,
      isCrashed: () => false,
      getZoomFactor: () => 1.5,
      replaceMisspelling: vi.fn(),
      session: {
        setPermissionRequestHandler: (handler: Listener) => { callbacks.permissionRequest = handler; },
        setPermissionCheckHandler: (handler: Listener) => { callbacks.permissionCheck = handler; },
        availableSpellCheckerLanguages: ["en-US"],
        getSpellCheckerLanguages: vi.fn(() => ["en-US"]),
        setSpellCheckerLanguages: vi.fn(),
        setSpellCheckerEnabled: vi.fn(),
        listWordsInSpellCheckerDictionary: vi.fn(async () => []),
        addWordToSpellCheckerDictionary: vi.fn(() => true),
        removeWordFromSpellCheckerDictionary: vi.fn(() => true),
      },
    },
    on: (event: string, listener: Listener) => { windowEvents.set(event, listener); },
    once: vi.fn(),
    loadFile: vi.fn(async () => {}),
    isDestroyed: () => false,
    isMinimized: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  };
  return {
    window,
    webContentsEvents,
    windowEvents,
    callbacks,
    handlers: new Map<string, Handler>(),
    listeners: new Map<string, Listener>(),
    appEvents: new Map<string, Listener>(),
    protocols: new Map<string, (request: Request) => Promise<Response>>(),
    quit: vi.fn(),
    showMessageBox: vi.fn<(window: unknown, options: MessageBoxOptions) => Promise<{ response: unknown }>>(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showErrorBox: vi.fn(),
    openExternal: vi.fn(async () => {}),
    showItemInFolder: vi.fn(),
    buildMenu: vi.fn((_template: MenuTemplate) => ({ popup: vi.fn() })),
    exposeInMainWorld: vi.fn<(name: string, bridge: ElectronBridge) => void>(),
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    rendererOn: vi.fn(),
    rendererOff: vi.fn(),
    rendererSend: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    setName: vi.fn(),
    getPath: () => "dev-temp/document-preferences/dialog-ipc",
    getVersion: () => "0.0.0",
    getPreferredSystemLanguages: () => ["en-US"],
    on: (event: string, listener: Listener) => { native.appEvents.set(event, listener); },
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit: native.quit,
    exit: vi.fn(),
  },
  BrowserWindow: class { constructor() { return native.window; } },
  dialog: {
    showMessageBox: native.showMessageBox, showOpenDialog: native.showOpenDialog,
    showSaveDialog: native.showSaveDialog, showErrorBox: native.showErrorBox,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => native.handlers.set(channel, handler),
    on: (channel: string, listener: Listener) => native.listeners.set(channel, listener),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: native.buildMenu },
  nativeTheme: { themeSource: "system" },
  net: {},
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => native.protocols.set(scheme, handler),
  },
  screen: {},
  shell: { openExternal: native.openExternal, showItemInFolder: native.showItemInFolder },
  systemPreferences: {},
  contextBridge: { exposeInMainWorld: native.exposeInMainWorld },
  ipcRenderer: { invoke: native.invoke, on: native.rendererOn, removeListener: native.rendererOff, send: native.rendererSend },
  webUtils: {},
}));

// Start the real IPC registration without accessing a profile, watching files,
// checking for updates, or creating an operating-system window.
vi.mock("./storage", () => ({
  adoptLegacyData: () => false,
  ConfigStore: class {
    directory = "dev-temp/document-preferences/dialog-ipc";
    settingsPath = "dev-temp/document-preferences/dialog-ipc/settings.toml";
    async initialize() {}
    async settings() { return { ...DEFAULT_SETTINGS, autoUpdate: false }; }
  },
  RecentSearch: class {},
}));
vi.mock("./updateInstall", () => ({ installedPackageKind: async () => null }));
vi.mock("./updater", () => ({
  Updater: class {
    async start() { return { pending: null, failure: null }; }
    async checkIfDue() {}
  },
}));
vi.mock("./printing", () => ({ PrintService: class {} }));
vi.mock("./watchers", () => ({ watchPath: () => () => {} }));

/** Supply the same sender and main frame that the app's trust check requires. */
function trustedEvent(): IpcMainInvokeEvent {
  return { sender: native.window.webContents, senderFrame: native.window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
}

const untrustedSources = ["another window", "a subframe of the entry page", "a main frame that left the entry page"] as const;

/** Run a request from an untrusted source, and restore the main frame afterwards. */
async function fromUntrusted(source: (typeof untrustedSources)[number], run: (event: IpcMainInvokeEvent) => unknown): Promise<void> {
  const frame = native.window.webContents.mainFrame;
  const originalUrl = frame.url;
  const event = { ...trustedEvent() };
  if (source === "another window") event.sender = {} as IpcMainInvokeEvent["sender"];
  if (source === "a subframe of the entry page") event.senderFrame = { url: originalUrl } as IpcMainInvokeEvent["senderFrame"];
  if (source === "a main frame that left the entry page") frame.url = "https://example.com/";
  try {
    await run(event);
  } finally {
    frame.url = originalUrl;
  }
}

/** Invoke the real registered handler through the mocked Electron transport. */
async function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = native.handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler(event, ...args);
}

/** Return a callback that main.ts registered during startup. */
function registered<T>(callback: T | undefined, name: string): T {
  if (!callback) throw new Error(`main.ts did not register ${name}`);
  return callback;
}

let bridge: ElectronBridge;
let fixtures: string;
let entry: string;

beforeAll(async () => {
  vi.stubEnv("DOWNPAD_USER_DATA_DIR", "");
  entry = new URL("../dist/index.html", import.meta.url).href;
  native.window.webContents.mainFrame.url = entry;
  await mkdir(resolve("dev-temp", "electron-main-ipc"), { recursive: true });
  fixtures = await mkdtemp(join(resolve("dev-temp", "electron-main-ipc"), "fixture-"));
  await import("./main");
  await vi.waitFor(() => expect(native.window.loadFile).toHaveBeenCalledOnce());
  expect(native.showErrorBox).not.toHaveBeenCalled();
  // Bundle the CommonJS preload just as the desktop build does. Vite does not
  // transform .cts imports, and this also exercises the sandbox entry point.
  const preload = await build({
    entryPoints: [fileURLToPath(new URL("./preload.cts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"],
  });
  runInNewContext(preload.outputFiles[0]!.text, {
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency ${name}`);
      return { contextBridge, ipcRenderer, webUtils };
    },
    process: { platform: process.platform },
  });
  expect(native.exposeInMainWorld).toHaveBeenCalledExactlyOnceWith("downpadDesktop", expect.any(Object));
  bridge = native.exposeInMainWorld.mock.calls[0]![1];
});

beforeEach(() => {
  native.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  native.invoke.mockReset().mockImplementation((channel, ...args) => invoke(channel, trustedEvent(), ...args));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(fixtures, { recursive: true, force: true });
});

describe("native unsaved-change dialog IPC", () => {
  it.each([
    [0, "save"],
    [1, "cancel"],
    [2, "discard"],
  ] as const)("maps native button %s to %s through preload", async (response, choice) => {
    native.showMessageBox.mockResolvedValueOnce({ response });

    await expect(bridge.confirmSaveChanges("Save changes to notes.md?")).resolves.toBe(choice);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("downpad:dialog-confirm-save-changes", "Save changes to notes.md?");
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(native.window, {
      type: "warning", title: "Downpad", message: "Save changes to notes.md?",
      buttons: ["Save", "Cancel", "Discard"], defaultId: 0, cancelId: 1, noLink: true,
    });
  });

  it.each([[undefined], [null], [false], [42], [{}], [[]]])("rejects malformed messages %j before opening a dialog", async (message) => {
    await expect(invoke("downpad:dialog-confirm-save-changes", trustedEvent(), message))
      .rejects.toThrow("A dialog message is required.");
    expect(native.showMessageBox).not.toHaveBeenCalled();
  });

  it.each([-1, 3, "0", "2", undefined, null])("treats an unexpected native response %j as cancel", async (response) => {
    native.showMessageBox.mockResolvedValueOnce({ response });
    await expect(bridge.confirmSaveChanges("Save changes?")).resolves.toBe("cancel");
  });

  it.each([undefined, null, false, 0, 2, "unknown", {}])("preload treats malformed IPC results %j as cancel", async (choice) => {
    native.invoke.mockResolvedValueOnce(choice);
    await expect(bridge.confirmSaveChanges("Save changes?")).resolves.toBe("cancel");
  });

  it("propagates native dialog failures", async () => {
    native.showMessageBox.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await expect(bridge.confirmSaveChanges("Save changes?")).rejects.toThrow("Dialog unavailable");
  });

  it.each([
    [0, false],
    [1, true],
  ] as const)("preserves discard-only ask button %s as %s", async (response, confirmed) => {
    native.showMessageBox.mockResolvedValueOnce({ response });
    await expect(bridge.ask("Discard changes and reload?", { kind: "warning", okLabel: "Discard" })).resolves.toBe(confirmed);
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(native.window, {
      type: "warning", title: "Downpad", message: "Discard changes and reload?",
      buttons: ["Cancel", "Discard"], defaultId: 0, cancelId: 0, noLink: true,
    });
  });
});

describe("desktop IPC trust", () => {
  it.each(untrustedSources)("rejects every desktop channel from %s before acting", async (source) => {
    const written = join(fixtures, "untrusted.md");
    // Arguments that the trusted page could send, so a channel that checked too late would act.
    const accepted: Record<string, unknown[]> = {
      "downpad:invoke": ["write_file", { path: written, content: "# Changed", eol: "lf" }],
      "downpad:dialog-open": [{}],
      "downpad:dialog-save": [{}],
      "downpad:dialog-ask": ["Discard changes?", {}],
      "downpad:dialog-confirm-save-changes": ["Save changes?"],
      "downpad:open-external": ["https://example.com/"],
      "downpad:image-url": [join(fixtures, "untrusted.png")],
      "downpad:reveal-item": [fixtures],
      "downpad:set-theme": ["dark"],
    };
    const channels = [...native.handlers.keys()];
    expect(channels).toEqual(expect.arrayContaining(Object.keys(accepted)));

    await fromUntrusted(source, async (event) => {
      for (const channel of channels) {
        await expect(invoke(channel, event, ...(accepted[channel] ?? [])), channel).rejects.toThrow("untrusted page");
      }
    });
    expect(existsSync(written)).toBe(false);
    for (const action of [native.showOpenDialog, native.showSaveDialog, native.showMessageBox, native.openExternal,
      native.showItemInFolder, native.window.close, native.quit]) {
      expect(action).not.toHaveBeenCalled();
    }
    expect(nativeTheme.themeSource).toBe("system");
  });

  it.each(untrustedSources)("ignores close and open listener changes from %s", async (source) => {
    const listen = (channel: string) => registered(native.listeners.get(channel), channel);
    const queued = join(fixtures, "queued.md");
    listen("downpad:close-listener")(trustedEvent(), true);
    try {
      await fromUntrusted(source, (event) => {
        listen("downpad:close-listener")(event, false);
        registered(native.appEvents.get("open-file"), "open-file")({ preventDefault() {} }, queued);
        listen("downpad:open-listener")(event, true);
      });
      expect(native.window.webContents.send).not.toHaveBeenCalled();

      const close = { preventDefault: vi.fn() };
      registered(native.windowEvents.get("close"), "close")(close);
      expect(close.preventDefault).toHaveBeenCalledOnce();
      expect(native.window.webContents.send).toHaveBeenCalledExactlyOnceWith("downpad:event:close-requested", undefined);

      listen("downpad:open-listener")(trustedEvent(), true);
      expect(native.window.webContents.send).toHaveBeenLastCalledWith("downpad:event:open-file-requested", { path: queued });
    } finally {
      listen("downpad:close-listener")(trustedEvent(), false);
      listen("downpad:open-listener")(trustedEvent(), false);
    }
  });
});

describe("main window navigation and permissions", () => {
  const contentsEvent = (name: string) => registered(native.webContentsEvents.get(name), name);

  it.each(["https://example.com/page", "http://example.com/", "mailto:someone@example.com"])("keeps the editor and opens %s outside the app", (url) => {
    const event = { preventDefault: vi.fn() };
    contentsEvent("will-navigate")(event, url);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each(["file:///etc/passwd", "data:text/html,<p>page</p>"])("keeps the editor and does not open %s", (url) => {
    const event = { preventDefault: vi.fn() };
    contentsEvent("will-navigate")(event, url);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("allows navigation within the entry page", () => {
    for (const url of [`${entry}#heading`, `${entry}?view=source`]) {
      const event = { preventDefault: vi.fn() };
      contentsEvent("will-navigate")(event, url);
      contentsEvent("will-redirect")(event, url);
      expect(event.preventDefault, url).not.toHaveBeenCalled();
    }
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("blocks redirects away from the entry page without opening them", () => {
    const event = { preventDefault: vi.fn() };
    contentsEvent("will-redirect")(event, "https://example.com/");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("denies every new window and opens only web and mail links outside the app", () => {
    const open = registered(native.callbacks.windowOpen, "the window open handler");
    expect(open({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(open({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");
  });

  it("refuses to attach webviews", () => {
    const event = { preventDefault: vi.fn() };
    contentsEvent("will-attach-webview")(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("grants clipboard access only to the editor's own main frame", () => {
    const request = registered(native.callbacks.permissionRequest, "the permission request handler");
    const check = registered(native.callbacks.permissionCheck, "the permission check handler");
    const details = { requestingUrl: entry, isMainFrame: true };
    const editor = native.window.webContents;
    const other = {};
    const callback = vi.fn();
    request(editor, "clipboard-read", callback, details);
    request(other, "clipboard-read", callback, details);
    request(editor, "notifications", callback, details);
    expect(callback.mock.calls).toEqual([[true], [false], [false]]);
    expect(check(editor, "clipboard-read", "file://", details)).toBe(true);
    expect(check(other, "clipboard-read", "file://", details)).toBe(false);
    expect(check(null, "clipboard-read", "file://", details)).toBe(false);
  });
});

describe("downpad-file protocol", () => {
  const serve = (url: string) => registered(native.protocols.get("downpad-file"), "the downpad-file protocol")(new Request(url));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  /** Authorize an image through the trusted page, as the renderer does before showing it. */
  async function authorizedImage(name: string): Promise<{ path: string; url: URL }> {
    const path = join(fixtures, name);
    await writeFile(path, svg);
    return { path, url: new URL(String(await invoke("downpad:image-url", trustedEvent(), path))) };
  }

  it("serves an authorized image with headers that keep it from running as a page", async () => {
    const { url } = await authorizedImage("served.svg");
    const response = await serve(url.href);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/svg+xml",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      // The file: entry page has an opaque origin, which Chromium sends as null.
      "access-control-allow-origin": "null",
    });
    await expect(response.text()).resolves.toBe(svg);
  });

  it.each([
    ["another host", "remote", "/image"],
    ["another path", "local", "/file"],
  ])("answers %s with 404 even for an authorized token", async (_case, host, pathname) => {
    const { url } = await authorizedImage("located.svg");
    url.host = host;
    url.pathname = pathname;
    expect((await serve(url.href)).status).toBe(404);
  });

  it("answers an invented token and an image removed after authorization with 403", async () => {
    const { path, url } = await authorizedImage("removed.svg");
    const invented = new URL(url);
    invented.searchParams.set("token", "00000000-0000-4000-8000-000000000000");
    expect((await serve(invented.href)).status).toBe(403);
    expect((await serve(url.href)).status).toBe(200);
    await rm(path);
    expect((await serve(url.href)).status).toBe(403);
  });
});

describe("preload bridge", () => {
  it.each([
    ["close-requested", "downpad:close-listener"],
    ["open-file-requested", "downpad:open-listener"],
  ] as const)("tells main only about the first and last %s listener", (event, channel) => {
    const first = bridge.listen(event, () => {});
    const second = bridge.listen(event, () => {});
    first();
    first();
    expect(native.rendererSend.mock.calls).toEqual([[channel, true]]);
    second();
    expect(native.rendererSend.mock.calls).toEqual([[channel, true], [channel, false]]);
    bridge.listen(event, () => {})();
    expect(native.rendererSend.mock.calls).toEqual([[channel, true], [channel, false], [channel, true], [channel, false]]);
    expect(native.rendererOff.mock.calls).toEqual(native.rendererOn.mock.calls);
  });

  it("rejects unknown commands and events without reaching main", async () => {
    await expect(bridge.invoke("unknown" as never)).rejects.toThrow("Unknown desktop command.");
    expect(() => bridge.listen("unknown" as never, () => {})).toThrow("Unknown desktop event.");
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.rendererOn).not.toHaveBeenCalled();
  });
});

describe("spelling context menu IPC", () => {
  type SpellingContext = DesktopEventPayloads["spelling-context-menu"];

  /** Right-click a word as Chromium reports it, and return the menu the renderer receives. */
  function openSpellingMenu(misspelledWord: string, dictionarySuggestions: string[]): SpellingContext {
    native.window.webContents.send.mockClear();
    registered(native.webContentsEvents.get("context-menu"), "context-menu")({}, { misspelledWord, dictionarySuggestions, x: 30, y: 60 });
    expect(native.window.webContents.send).toHaveBeenCalledExactlyOnceWith("downpad:event:spelling-context-menu", expect.any(Object));
    return native.window.webContents.send.mock.calls[0]![1] as SpellingContext;
  }

  const spellingAction = (args: Record<string, unknown>) => invoke("downpad:invoke", trustedEvent(), "spelling_menu_action", args);

  it("sends the word, at most six suggestions, and a zoom-corrected position to the renderer", () => {
    const suggestions = ["spelling", "spieling", "spewing", "spline", "sapling", "seeling", "selling"];
    expect(openSpellingMenu("speling", suggestions)).toEqual({
      id: expect.any(Number), x: 20, y: 40, word: "speling", suggestions: suggestions.slice(0, 6),
    });
  });

  it("replaces the misspelling only with a suggestion offered by the current menu", async () => {
    const stale = openSpellingMenu("speling", ["spelling"]);
    const current = openSpellingMenu("speling", ["spelling"]);
    await expect(spellingAction({ contextId: current.id, action: "replace", suggestion: "injected" }))
      .rejects.toThrow("This spelling suggestion is unavailable.");
    await expect(spellingAction({ contextId: stale.id, action: "replace", suggestion: "spelling" }))
      .rejects.toThrow("This spelling menu has closed.");
    expect(native.window.webContents.replaceMisspelling).not.toHaveBeenCalled();

    await spellingAction({ contextId: current.id, action: "replace", suggestion: "spelling" });
    expect(native.window.webContents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith("spelling");
    await expect(spellingAction({ contextId: current.id, action: "replace", suggestion: "spelling" }))
      .rejects.toThrow("This spelling menu has closed.");
  });

  it("adds only the menu's misspelled word to the dictionary", async () => {
    const correct = openSpellingMenu("", []);
    await expect(spellingAction({ contextId: correct.id, action: "add" })).rejects.toThrow("Unknown spelling menu action.");
    expect(native.window.webContents.session.addWordToSpellCheckerDictionary).not.toHaveBeenCalled();

    const misspelled = openSpellingMenu("speling", ["spelling"]);
    await spellingAction({ contextId: misspelled.id, action: "add" });
    expect(native.window.webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith("speling");
    await expect(spellingAction({ contextId: misspelled.id, action: "add" })).rejects.toThrow("This spelling menu has closed.");
  });

  it("rejects unknown actions and dismisses only the current menu", async () => {
    const stale = openSpellingMenu("speling", ["spelling"]);
    const current = openSpellingMenu("speling", ["spelling"]);
    await expect(spellingAction({ contextId: current.id, action: "delete" })).rejects.toThrow("Unknown spelling menu action.");
    await spellingAction({ contextId: stale.id, action: "dismiss" });
    await expect(spellingAction({ contextId: current.id, action: "delete" })).rejects.toThrow("Unknown spelling menu action.");
    await spellingAction({ contextId: current.id, action: "dismiss" });
    await expect(spellingAction({ contextId: current.id, action: "delete" })).rejects.toThrow("This spelling menu has closed.");
  });

  it("applies a native menu suggestion only while its menu is current", async () => {
    const menu = openSpellingMenu("speling", ["spelling"]);
    await spellingAction({ contextId: menu.id, action: "native" });
    expect(native.buildMenu).toHaveBeenCalledOnce();
    const suggestion = native.buildMenu.mock.calls[0]![0].find((item) => item.label === "spelling");
    suggestion?.click?.();
    expect(native.window.webContents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith("spelling");

    openSpellingMenu("speling", ["spelling"]);
    suggestion?.click?.();
    expect(native.window.webContents.replaceMisspelling).toHaveBeenCalledOnce();
  });
});
