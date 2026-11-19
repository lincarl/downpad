// @vitest-environment jsdom
// The Settings dialog's save checks Git once a write turns it on, also when
// a failed write is tried again.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElectronBridge } from "../ipc/bridge";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { SettingsModel } from "../settings/SettingsModel";
import type { Settings } from "../state/types";
import { createAppStore } from "./createAppStore";
import { saveDialogSettings } from "./saveDialogSettings";

const loaded: Settings = { ...DEFAULT_SETTINGS, gitEnabled: false };

/** A desktop bridge whose settings writes fail while `broken` is set. */
function desktop() {
  const state = { broken: false };
  window.downpadDesktop = {
    platform: "linux",
    invoke: vi.fn(async (command: string) => {
      if (command === "load_settings") return loaded;
      if (command === "save_settings" && state.broken) throw new Error("invalid TOML");
      if (command === "save_settings") return undefined;
      throw new Error(`Unexpected command ${command}`);
    }),
    listen: () => () => {},
    setTheme: async () => {},
  } as unknown as ElectronBridge;
  return state;
}

afterEach(() => {
  delete window.downpadDesktop;
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("saveDialogSettings", () => {
  it("checks Git once the write that turns it on succeeds, and not after a failed one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = desktop();
    const store = createAppStore();
    const settings = new SettingsModel(store, () => {});
    await settings.init();
    const git = { check: vi.fn(async () => {}) };
    const deps = { store, settings, git };

    disk.broken = true;
    expect(await saveDialogSettings({ ...loaded, gitEnabled: true }, deps)).toBe(false);
    expect(git.check).not.toHaveBeenCalled();
    expect(store.get().settings.gitEnabled).toBe(false);

    // The user repairs the file and tries again.
    disk.broken = false;
    expect(await saveDialogSettings({ ...loaded, gitEnabled: true }, deps)).toBe(true);
    expect(git.check).toHaveBeenCalledExactlyOnceWith({ force: true });

    // A save that leaves Git on checks nothing more.
    expect(await saveDialogSettings({ ...store.get().settings, editorWidthPx: 900 }, deps)).toBe(true);
    expect(git.check).toHaveBeenCalledOnce();
    settings.destroy();
  });
});
