// @vitest-environment jsdom
// SettingsModel applies settings to the page, writes saves to disk in order and
// re-mounts the document view only for settings that change its Markdown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import type { ElectronBridge } from "../ipc/bridge";
import type { Settings } from "../state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsModel } from "./SettingsModel";

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Write {
  settings: Settings;
  finish(): void;
  fail(error: Error): void;
}

/**
 * A desktop bridge that records settings writes, holds each one until the test
 * finishes it when `holdWrites` is set, sends settings-changed events, and
 * answers the system accent when the test says so.
 */
function desktop({ loaded = DEFAULT_SETTINGS as Settings | Error, holdWrites = false } = {}) {
  const writes: Write[] = [];
  const systemAccent = deferred<string | null>();
  let handler: ((settings: Settings) => void) | null = null;
  const unlisten = vi.fn();
  const invoke = vi.fn((command: string, args?: { settings: Settings }) => {
    if (command === "load_settings") return loaded instanceof Error ? Promise.reject(loaded) : Promise.resolve(loaded);
    if (command === "get_system_accent_color") return systemAccent.promise;
    if (command === "save_settings") {
      const write = deferred<void>();
      writes.push({ settings: args!.settings, finish: () => write.resolve(), fail: write.reject });
      if (!holdWrites) write.resolve();
      return write.promise;
    }
    return Promise.reject(new Error(`Unexpected command ${command}`));
  });
  window.downpadDesktop = {
    platform: "linux",
    invoke,
    listen: (_event: string, listener: (settings: Settings) => void) => {
      handler = listener;
      return unlisten;
    },
    setTheme: async () => {},
  } as unknown as ElectronBridge;
  return {
    writes,
    invoke,
    unlisten,
    systemAccent,
    /** Deliver an edit of settings.toml, as the main process's watcher does. */
    send: (settings: Settings) => handler?.(settings),
  };
}

const models: SettingsModel[] = [];

/** A started model over a fresh store. */
async function started() {
  const store = createAppStore();
  const remount = vi.fn();
  const model = new SettingsModel(store, remount);
  models.push(model);
  await model.init();
  return { store, model, remount };
}

/** Let every pending promise callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const root = document.documentElement;
const cssVar = (name: string): string => root.style.getPropertyValue(name);

afterEach(() => {
  for (const model of models.splice(0)) model.destroy();
  delete window.downpadDesktop;
  for (const name of ["style", "data-theme", "data-editor-theme", "data-width-mode"]) root.removeAttribute(name);
  vi.restoreAllMocks();
});

describe("SettingsModel start and stop", () => {
  it("starts with the saved settings, or keeps the defaults when they cannot be read", async () => {
    const saved: Settings = { ...DEFAULT_SETTINGS, editorWidthPx: 900, mdBulletChar: "*" };
    desktop({ loaded: saved });
    const { store } = await started();
    expect(store.get().settings).toEqual(saved);
    expect(cssVar("--editor-width")).toBe("900px");

    desktop({ loaded: new Error("unreadable") });
    const fallback = await started();
    expect(fallback.store.get().settings).toEqual(DEFAULT_SETTINGS);
    expect(cssVar("--editor-width")).toBe("1188px");
  });

  it("ignores saves and settings file edits after destroy", async () => {
    const disk = desktop();
    const { store, model } = await started();
    model.destroy();
    expect(disk.unlisten).toHaveBeenCalledOnce();

    await model.save({ ...DEFAULT_SETTINGS, theme: "light" });
    disk.send({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(store.get().settings).toEqual(DEFAULT_SETTINGS);
    expect(disk.writes).toEqual([]);
  });
});

describe("SettingsModel saves", () => {
  it("writes saves one at a time, in the order they were made", async () => {
    // At first run the welcome flag and the default-handler flag are saved by
    // two calls that nobody awaits. A write that overtook the other dropped a flag.
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const first = model.save({ ...store.get().settings, hasSeenWelcome: true });
    const second = model.save({ ...store.get().settings, hasCheckedDefaultHandler: true });
    await flush();
    expect(disk.writes.map((write) => write.settings)).toEqual([
      { ...DEFAULT_SETTINGS, hasSeenWelcome: true },
    ]);

    disk.writes[0].finish();
    await first;
    await flush();
    expect(disk.writes.map((write) => write.settings)).toEqual([
      { ...DEFAULT_SETTINGS, hasSeenWelcome: true },
      { ...DEFAULT_SETTINGS, hasSeenWelcome: true, hasCheckedDefaultHandler: true },
    ]);
    disk.writes[1].finish();
    await second;
  });

  it("applies a save whose write fails, and still writes the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const first = model.save({ ...DEFAULT_SETTINGS, editorWidthPx: 800 });
    const second = model.save({ ...DEFAULT_SETTINGS, editorWidthPx: 900 });
    await flush();
    disk.writes[0].fail(new Error("disk full"));
    await first;
    expect(error).toHaveBeenCalledWith("Downpad: failed to save settings", expect.any(Error));

    await flush();
    expect(disk.writes).toHaveLength(2);
    disk.writes[1].finish();
    await second;
    expect(store.get().settings.editorWidthPx).toBe(900);
    expect(cssVar("--editor-width")).toBe("900px");
  });
});

describe("SettingsModel document view re-mount", () => {
  it("re-mounts the document view for each save that changes how it writes or shows Markdown", async () => {
    desktop();
    const { model, remount } = await started();
    const changes: Partial<Settings>[] = [
      { mdBulletChar: "*" },
      { mdEmphasisChar: "_" },
      { mdStrongChar: "__" },
      { mdHeadingStyle: "setext" },
      { mdHardWrap: 80 },
      { linkDisplay: "text-only" },
      { showFrontmatterPanel: false },
    ];
    let settings: Settings = DEFAULT_SETTINGS;
    for (const change of changes) {
      settings = { ...settings, ...change };
      await model.save(settings);
      expect(remount, JSON.stringify(change)).toHaveBeenCalledOnce();
      remount.mockClear();
    }
    // Saving the same Markdown settings again keeps the view.
    await model.save({ ...settings });
    expect(remount).not.toHaveBeenCalled();
  });

  it("keeps the document view for theme, page, font, accent, spelling and app settings", async () => {
    desktop();
    const { model, remount } = await started();
    const changes: Partial<Settings>[] = [
      { theme: "light" },
      { editorTheme: "dark" },
      { editorWidthMode: "fill" },
      { editorWidthPx: 800 },
      { fontFamily: "Georgia" },
      { editorFontScale: 1.5 },
      { accentMode: "custom", accentColor: "#123456" },
      { spellCheckEnabled: false },
      { hasSeenWelcome: true },
    ];
    let settings: Settings = DEFAULT_SETTINGS;
    for (const change of changes) {
      settings = { ...settings, ...change };
      await model.save(settings);
    }
    expect(remount).not.toHaveBeenCalled();
  });

  it("applies a settings file edit, re-mounting only when it changes the Markdown settings", async () => {
    const disk = desktop();
    const { store, remount } = await started();
    disk.send({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(store.get().settings.theme).toBe("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(remount).not.toHaveBeenCalled();

    disk.send({ ...DEFAULT_SETTINGS, theme: "light", mdBulletChar: "*" });
    expect(store.get().settings.mdBulletChar).toBe("*");
    expect(remount).toHaveBeenCalledOnce();
    // The edit came from the file, so nothing is written back.
    expect(disk.writes).toEqual([]);
  });
});

describe("SettingsModel page appearance", () => {
  it("applies the page width, body font, text size and themes", async () => {
    desktop();
    const { model } = await started();
    await model.save({
      ...DEFAULT_SETTINGS,
      editorWidthMode: "fixed",
      editorWidthPx: 800,
      fontFamily: "Georgia",
      editorFontScale: 1.25,
      theme: "light",
      editorTheme: "follow-ui",
    });
    expect(cssVar("--editor-width")).toBe("800px");
    expect(root.getAttribute("data-width-mode")).toBe("fixed");
    // A fallback stack keeps a sans-serif face when the family is missing.
    expect(cssVar("--editor-font")).toBe("Georgia, system-ui, sans-serif");
    expect(cssVar("--editor-font-scale")).toBe("1.25");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-editor-theme")).toBe("light");

    await model.save({ ...DEFAULT_SETTINGS, editorWidthMode: "fill" });
    expect(root.getAttribute("data-width-mode")).toBe("fill");
  });

  it("uses a custom accent with readable text on it, the default blue for an invalid one, and the theme's in default mode", async () => {
    desktop();
    const { model } = await started();
    await model.save({ ...DEFAULT_SETTINGS, accentMode: "custom", accentColor: "#FFD400" });
    expect(cssVar("--accent")).toBe("#ffd400");
    expect(cssVar("--accent-fg")).toBe("#1a1a1a");

    await model.save({ ...DEFAULT_SETTINGS, accentMode: "custom", accentColor: "nope" });
    expect(cssVar("--accent")).toBe("#0969da");
    expect(cssVar("--accent-fg")).toBe("#ffffff");

    // The theme's own tokens supply the default accent.
    await model.save({ ...DEFAULT_SETTINGS, accentMode: "default" });
    expect(cssVar("--accent")).toBe("");
    expect(cssVar("--accent-fg")).toBe("");
  });

  it("applies the system accent when the system answers after System was chosen", async () => {
    const disk = desktop();
    const { model } = await started();

    await model.save({ ...DEFAULT_SETTINGS, accentMode: "system" });
    expect(cssVar("--accent")).toBe("");
    disk.systemAccent.resolve("#FFD400");
    await flush();
    expect(cssVar("--accent")).toBe("#ffd400");
    expect(cssVar("--accent-fg")).toBe("#1a1a1a");
  });

  it("keeps an accent chosen before the system answers, then reuses the answer without asking again", async () => {
    const disk = desktop();
    const { model } = await started();
    const askedForAccent = () => disk.invoke.mock.calls.filter(([command]) => command === "get_system_accent_color");

    await model.save({ ...DEFAULT_SETTINGS, accentMode: "system" });
    expect(cssVar("--accent")).toBe("");
    await model.save({ ...DEFAULT_SETTINGS, accentMode: "custom", accentColor: "#123456" });
    disk.systemAccent.resolve("#FFD400");
    await flush();
    expect(cssVar("--accent")).toBe("#123456");

    await model.save({ ...DEFAULT_SETTINGS, accentMode: "system" });
    expect(cssVar("--accent")).toBe("#ffd400");
    expect(cssVar("--accent-fg")).toBe("#1a1a1a");
    expect(askedForAccent()).toHaveLength(1);
  });

  it("applies no system accent that arrives after destroy", async () => {
    const disk = desktop();
    const { model } = await started();
    await model.save({ ...DEFAULT_SETTINGS, accentMode: "system" });
    model.destroy();
    disk.systemAccent.resolve("#ffd400");
    await flush();
    expect(cssVar("--accent")).toBe("");
  });
});
