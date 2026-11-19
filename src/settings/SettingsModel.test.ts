// @vitest-environment jsdom
// SettingsModel applies settings to the page, writes saves to disk in order and
// re-mounts the document view only for settings that change its Markdown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import type { ElectronBridge } from "../ipc/bridge";
import type { Settings } from "../state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SETTINGS_ENCODING_BROKEN, SETTINGS_SYNTAX_BROKEN } from "../ipc/contracts";
import { SettingsModel } from "./SettingsModel";
import { withRecentLimit } from "./settingsChanges";

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
  changes: Partial<Settings>;
  expected?: Partial<Settings>;
  /** End the write, which returns `result`, or by default the file with the
   *  changes on it. */
  finish(result?: Settings): void;
  fail(error: Error): void;
}

/**
 * A desktop bridge that records settings writes, holds each one until the test
 * finishes it when `holdWrites` is set, sends settings-changed events, and
 * answers the system accent when the test says so. Like the main process, it
 * puts each write's changes onto its file, skips a change whose expected value
 * the file no longer holds, keeps no more recent files shown than kept, and
 * returns the result.
 */
function desktop({ loaded = DEFAULT_SETTINGS as Settings | Error, holdWrites = false } = {}) {
  const writes: Write[] = [];
  let file: Settings = loaded instanceof Error ? DEFAULT_SETTINGS : loaded;
  const systemAccent = deferred<string | null>();
  let handler: ((settings: Settings) => void) | null = null;
  const unlisten = vi.fn();
  const invoke = vi.fn((command: string, args?: { changes: Partial<Settings>; expected?: Partial<Settings> }) => {
    if (command === "load_settings") return loaded instanceof Error ? Promise.reject(loaded) : Promise.resolve(loaded);
    if (command === "get_system_accent_color") return systemAccent.promise;
    if (command === "save_settings") {
      const write = deferred<Settings>();
      const { changes, expected } = args!;
      const applies = ([key]: [string, unknown]) =>
        !expected || !(key in expected) || JSON.stringify(file[key as keyof Settings]) === JSON.stringify(expected[key as keyof Settings]);
      writes.push({
        changes,
        expected,
        finish: (result) =>
          write.resolve(result ?? (file = withRecentLimit({ ...file, ...Object.fromEntries(Object.entries(changes).filter(applies)) }))),
        fail: write.reject,
      });
      if (!holdWrites) writes.at(-1)!.finish();
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
    send: (settings: Settings) => {
      file = settings;
      handler?.(settings);
    },
    /** Edit settings.toml without the watcher telling the app yet. */
    edit: (settings: Settings) => {
      file = settings;
    },
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
  it("writes saves one at a time, in the order they were made, each with its own changes", async () => {
    // At first run the welcome flag and the default-handler flag are saved by
    // two calls that nobody awaits. A write that overtook the other dropped a flag.
    const disk = desktop({ holdWrites: true });
    const { model } = await started();
    const first = model.save({ hasSeenWelcome: true });
    const second = model.save({ hasCheckedDefaultHandler: true });
    await flush();
    expect(disk.writes.map((write) => write.changes)).toEqual([{ hasSeenWelcome: true }]);

    disk.writes[0].finish();
    expect(await first).toEqual({ ...DEFAULT_SETTINGS, hasSeenWelcome: true });
    await flush();
    expect(disk.writes.map((write) => write.changes)).toEqual([{ hasSeenWelcome: true }, { hasCheckedDefaultHandler: true }]);
    disk.writes[1].finish();
    expect(await second).toEqual({ ...DEFAULT_SETTINGS, hasSeenWelcome: true, hasCheckedDefaultHandler: true });
  });

  it("keeps a save whose write fails in use, reports it, and writes it with the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const first = model.save({ editorWidthPx: 800 });
    const second = model.save({ theme: "light" });
    await flush();
    disk.writes[0].fail(new Error("disk full"));
    expect(await first).toBeNull();
    expect(error).toHaveBeenCalledWith("Downpad: failed to save settings", expect.any(Error));
    expect(store.get().settings.editorWidthPx).toBe(800);

    await flush();
    expect(disk.writes[1].changes).toEqual({ editorWidthPx: 800, theme: "light" });
    disk.writes[1].finish();
    expect(await second).toMatchObject({ editorWidthPx: 800, theme: "light" });
    expect(cssVar("--editor-width")).toBe("800px");
  });

  it("stops using a failed save that asks for it, while a setting changed since keeps its new value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const saved = model.save({ editorWidthPx: 800 }, { undoIfUnwritten: true });
    // The page shows the change while the write runs.
    expect(cssVar("--editor-width")).toBe("800px");
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await saved).toBeNull();
    expect(store.get().settings).toEqual(DEFAULT_SETTINGS);
    expect(cssVar("--editor-width")).toBe(`${DEFAULT_SETTINGS.editorWidthPx}px`);

    const again = model.save({ editorWidthPx: 800 }, { undoIfUnwritten: true });
    const later = model.save({ editorWidthPx: 900 });
    await flush();
    disk.writes[1].fail(new Error("invalid TOML"));
    expect(await again).toBeNull();
    expect(store.get().settings.editorWidthPx).toBe(900);
    await flush();
    expect(disk.writes[2].changes).toEqual({ editorWidthPx: 900 });
    disk.writes[2].finish();
    await later;
  });

  it("never writes a failed change that was undone through another save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    // A text size change while the dialog's write runs.
    const dialog = model.save({ editorWidthPx: 800 }, { undoIfUnwritten: true });
    const zoom = model.save({ editorFontScale: 1.1 });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await dialog).toBeNull();
    expect(store.get().settings).toEqual({ ...DEFAULT_SETTINGS, editorFontScale: 1.1 });

    await flush();
    expect(disk.writes[1].changes).toEqual({ editorFontScale: 1.1 });
    disk.writes[1].finish();
    expect(await zoom).toEqual({ ...DEFAULT_SETTINGS, editorFontScale: 1.1 });
  });

  it("stops using only the failed save's own changes, not those of the saves after it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    // The toolbar goes to 110% and back to 120% while the dialog's 120% is
    // being written.
    const dialog = model.save({ editorFontScale: 1.2 }, { undoIfUnwritten: true });
    const smaller = model.save({ editorFontScale: 1.1 });
    const larger = model.save({ editorFontScale: 1.2 });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await dialog).toBeNull();
    expect(store.get().settings.editorFontScale).toBe(1.2);
    for (const index of [1, 2]) {
      await flush();
      disk.writes[index].finish();
    }
    await Promise.all([smaller, larger]);
    expect(store.get().settings.editorFontScale).toBe(1.2);
  });

  it("puts back no earlier change whose write failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    // The dialog closed while its first save ran and opened again.
    const first = model.save({ editorWidthPx: 800 }, { undoIfUnwritten: true });
    const second = model.save({ theme: "light" }, { undoIfUnwritten: true });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await first).toBeNull();
    await flush();
    expect(disk.writes[1].changes).toEqual({ theme: "light" });
    disk.writes[1].fail(new Error("invalid TOML"));
    expect(await second).toBeNull();
    expect(store.get().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps an edit of settings.toml that arrives while a write runs, also when the write's answer comes later", async () => {
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const saved = model.save({ theme: "dark" });
    await flush();
    disk.send({ ...DEFAULT_SETTINGS, editorWidthPx: 700 });
    // The change being written stays in use.
    expect(store.get().settings).toMatchObject({ editorWidthPx: 700, theme: "dark" });
    // The write ended before the edit.
    disk.writes[0].finish({ ...DEFAULT_SETTINGS, theme: "dark" });
    await saved;
    expect(store.get().settings).toEqual({ ...DEFAULT_SETTINGS, editorWidthPx: 700, theme: "dark" });
  });

  it("lets an edit of settings.toml replace the kept changes of failed writes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const zoom = model.save({ editorFontScale: 1.1 });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await zoom).toBeNull();
    // The next write takes the kept change along, and the file is repaired
    // while it runs, which also fails.
    const theme = model.save({ theme: "dark" });
    await flush();
    expect(disk.writes[1].changes).toEqual({ editorFontScale: 1.1, theme: "dark" });
    disk.send(DEFAULT_SETTINGS);
    disk.writes[1].fail(new Error("invalid TOML"));
    expect(await theme).toBeNull();
    expect(store.get().settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });

    const width = model.save({ editorWidthPx: 900 });
    await flush();
    expect(disk.writes[2].changes).toEqual({ theme: "dark", editorWidthPx: 900 });
    disk.writes[2].finish();
    await width;
  });

  it("applies a kept change only over the value it was made over, so a hand edit not read yet wins", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const zoom = model.save({ editorFontScale: 1.1 });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    expect(await zoom).toBeNull();
    // The user repairs the file and sets another size there, and saves a
    // setting before the app has read the repair.
    disk.edit({ ...DEFAULT_SETTINGS, editorFontScale: 1.5 });
    const theme = model.save({ theme: "dark" });
    await flush();
    expect(disk.writes[1]).toMatchObject({
      changes: { editorFontScale: 1.1, theme: "dark" },
      expected: { editorFontScale: DEFAULT_SETTINGS.editorFontScale },
    });
    disk.writes[1].finish();
    expect(await theme).toMatchObject({ editorFontScale: 1.5, theme: "dark" });
    expect(store.get().settings).toMatchObject({ editorFontScale: 1.5, theme: "dark" });
  });

  it("writes a save whose change throws while it applies, so the change does not stay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model, remount } = await started();
    remount.mockImplementationOnce(() => {
      throw new Error("remount failed");
    });
    await expect(model.save({ mdBulletChar: "*" }, { undoIfUnwritten: true })).rejects.toThrow("remount failed");
    await flush();
    expect(disk.writes.map((write) => write.changes)).toEqual([{ mdBulletChar: "*" }]);
    disk.writes[0].fail(new Error("invalid TOML"));
    await flush();
    // The failed change no longer applies, so an edit of the file shows.
    disk.send({ ...DEFAULT_SETTINGS, mdBulletChar: "+" });
    expect(store.get().settings.mdBulletChar).toBe("+");
  });

  it("keeps a change whose write failed on a broken settings file in use, and sends it with no later write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const zoom = model.save({ editorFontScale: 1.1 });
    await flush();
    disk.writes[0].fail(new Error(`${SETTINGS_SYNTAX_BROKEN} Fix the file's syntax before saving settings.`));
    expect(await zoom).toBeNull();
    expect(store.get().settings.editorFontScale).toBe(1.1);

    const theme = model.save({ theme: "dark" });
    await flush();
    expect(disk.writes[1].changes).toEqual({ theme: "dark" });
    disk.writes[1].finish();
    await theme;
    expect(store.get().settings).toMatchObject({ editorFontScale: 1.1, theme: "dark" });
    // An edit of the file replaces it.
    disk.send({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(store.get().settings.editorFontScale).toBe(DEFAULT_SETTINGS.editorFontScale);
  });

  it("treats a write that failed on a settings file with invalid UTF-8 as one on broken syntax", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { model } = await started();
    const zoom = model.save({ editorFontScale: 1.1 });
    await flush();
    disk.writes[0].fail(new Error(`${SETTINGS_ENCODING_BROKEN} Convert the file to UTF-8 before saving settings.`));
    expect(await zoom).toBeNull();
    const theme = model.save({ theme: "dark" });
    await flush();
    expect(disk.writes[1].changes).toEqual({ theme: "dark" });
    disk.writes[1].finish();
    await theme;
  });

  it("shows no more recent files than kept, before and after the write", async () => {
    const disk = desktop({ holdWrites: true });
    const { store, model } = await started();
    const saved = model.save({ recentFilesMaxRetained: 10 });
    expect(store.get().settings).toMatchObject({ recentFilesMaxRetained: 10, recentFilesVisibleCount: 10 });
    await flush();
    disk.writes[0].finish();
    expect(await saved).toMatchObject({ recentFilesMaxRetained: 10, recentFilesVisibleCount: 10 });
    expect(store.get().settings).toMatchObject({ recentFilesMaxRetained: 10, recentFilesVisibleCount: 10 });
  });

  it("goes on writing after code that runs on a change throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop({ holdWrites: true });
    const { model, remount } = await started();
    // The document view re-mounts when the change applies, and throws when
    // the failed change goes.
    remount.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error("remount failed");
    });
    const first = model.save({ mdBulletChar: "*" }, { undoIfUnwritten: true });
    await flush();
    disk.writes[0].fail(new Error("invalid TOML"));
    await expect(first).rejects.toThrow("remount failed");

    const second = model.save({ theme: "light" });
    await flush();
    disk.writes[1].finish();
    expect(await second).toMatchObject({ theme: "light" });
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
