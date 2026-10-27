// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "@/ipc/contracts";
import type { Settings } from "@/state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialogView } from "./SettingsDialogView";

function renderDialog(initial: Settings = DEFAULT_SETTINGS, restartIfSaved?: () => Promise<boolean>) {
  const onSave = vi.fn<(next: Settings) => void>();
  const onRequestClose = vi.fn();
  render(
    <SettingsDialogView initial={initial} onSave={onSave} onRequestClose={onRequestClose} restartIfSaved={restartIfSaved} />,
  );
  return { onSave, onRequestClose, user: userEvent.setup() };
}

/** A theme card's radio inside the named picker ("UI theme" or "Document theme"). */
const card = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

const checkedValue = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

afterEach(() => cleanup());

// Each test draws the whole dialog and drives it with user-event. That takes
// about 1.3s alone, and more than the default 5s when the full suite runs on a
// busy machine.
vi.setConfig({ testTimeout: 20_000 });

describe("SettingsDialogView accessibility", () => {
  it("describes the dialog and gives the accent picker independent button semantics", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "Configure the editor appearance",
    );

    // The Appearance page is hidden until selected, but stays in the tree.
    const accentButton = screen.getByRole("button", {
      name: "Choose custom accent color",
      hidden: true,
    });
    expect(accentButton.closest("label")).toBeNull();
    expect(accentButton.closest(".dialog-row")?.textContent).toContain("Accent color");

    // The theme pickers are native radio groups behind the cards.
    expect(checkedValue("theme")).toBe("dark");
    expect(checkedValue("editorTheme")).toBe("light");
    expect(
      screen.getByRole("radio", { name: "Follow system", hidden: true }).getAttribute("name"),
    ).toBe("theme");
  });
});

describe("SettingsDialogView landmarks and groups", () => {
  it("adds no unnamed landmark or group to any page", async () => {
    const { user } = renderDialog();
    // The tab list names the pages; a navigation landmark around it would add an unnamed stop.
    expect(screen.queryByRole("navigation")).toBeNull();
    for (const tab of screen.getAllByRole("tab")) {
      await user.click(tab);
      const groups = within(screen.getByRole("tabpanel")).queryAllByRole("group");
      const unnamed = groups.filter((group) => !group.hasAttribute("aria-labelledby") && !group.hasAttribute("aria-label"));
      expect(unnamed, tab.textContent ?? "").toEqual([]);
    }
    // A titled box is a group named by its title.
    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.getByRole("group", { name: "Autosave" })).toBeTruthy();
  });
});

describe("SettingsDialogView pages", () => {
  it("switches pages with the arrow keys and keeps every page mounted", async () => {
    const { user } = renderDialog();
    const general = screen.getByRole("tab", { name: "General" });
    expect(general.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(general);

    // Inactive pages stay in the form, hidden.
    const fixedWidth = document.querySelector('input[name="editorWidthPx"]');
    expect(fixedWidth?.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);

    await user.keyboard("{ArrowDown}");
    const appearance = screen.getByRole("tab", { name: "Appearance" });
    expect(appearance.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(appearance);
    expect(fixedWidth?.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(false);
    expect(general.getAttribute("aria-selected")).toBe("false");

    // ArrowUp stops at the first page; End reaches About across the divider.
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(general.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "About" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("MIT License");
  });

  it("moves into the page on Enter without saving", async () => {
    const { user, onSave } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(card("UI theme", "Dark"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves fields from every page, including hidden ones", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    const search = screen.getByRole("combobox", { name: "Default search:" }) as HTMLSelectElement;
    const keepRemoved = screen.getByRole("checkbox", { name: "Keep removed files in list" }) as HTMLInputElement;
    expect(search.value).toBe("names");
    expect(keepRemoved.checked).toBe(false);
    await user.selectOptions(search, "all");
    await user.click(keepRemoved);
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    await user.click(card("UI theme", "Light"));
    await user.click(card("Document theme", "Follow UI theme"));
    const width = document.querySelector<HTMLInputElement>('input[name="editorWidthPx"]')!;
    await user.clear(width);
    await user.type(width, "800");
    await user.click(screen.getByRole("tab", { name: "Markdown" }));
    await user.selectOptions(document.querySelector('select[name="mdBulletChar"]')!, "*");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      theme: "light",
      editorTheme: "follow-ui",
      editorWidthPx: 800,
      mdBulletChar: "*",
      recentFilesDefaultSearch: "all",
      recentFilesKeepRemoved: true,
      // Untouched fields on other pages keep their values.
      showFrontmatterPanel: DEFAULT_SETTINGS.showFrontmatterPanel,
      recentFilesVisibleCount: DEFAULT_SETTINGS.recentFilesVisibleCount,
      accentMode: "default",
    });
    expect(onRequestClose).toHaveBeenCalled();
  });

  it("saves an out-of-range number on a hidden page clamped to its range", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, autosaveEnabled: true });
    const interval = document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!;
    await user.clear(interval);
    await user.type(interval, "2");
    await user.click(screen.getByRole("tab", { name: "Appearance" }));

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].autosaveIntervalSeconds).toBe(5);
  });

  it("saves a decimal number as a whole number, as settings.toml requires", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, mdHardWrap: 80 });
    await user.click(screen.getByRole("tab", { name: "Markdown" }));
    const column = document.querySelector<HTMLInputElement>('input[name="hardWrapCol"]')!;
    await user.clear(column);
    await user.type(column, "72.6");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0].mdHardWrap).toBe(73);
  });

  it("disables the fields that depend on an unchecked box", async () => {
    const { user } = renderDialog({ ...DEFAULT_SETTINGS, autosaveEnabled: false });
    const interval = document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!;
    expect(interval.disabled).toBe(true);
    await user.click(document.querySelector<HTMLInputElement>('input[name="autosaveEnabled"]')!);
    expect(interval.disabled).toBe(false);
  });

  it("closes on Escape without saving", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onRequestClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("SettingsDialogView accent", () => {
  const save = async (user: ReturnType<typeof userEvent.setup>, onSave: ReturnType<typeof vi.fn>) => {
    await user.click(screen.getByRole("button", { name: "Save" }));
    return onSave.mock.calls.at(-1)?.[0] as Settings;
  };

  it("maps the system check box, Reset and a picked colour to the accent mode", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, accentMode: "custom", accentColor: "#ff8800" });
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    const swatch = screen.getByRole("button", { name: "Choose custom accent color" });
    const system = screen.getByRole("checkbox", { name: "Use the system accent color" });
    const reset = screen.getByRole("button", { name: "Reset" });

    await user.click(system);
    expect((swatch as HTMLButtonElement).disabled).toBe(true);
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    // Unchecking returns to the custom colour chosen before.
    await user.click(system);
    expect(swatch.style.background).toBe("rgb(255, 136, 0)");

    await user.click(reset);
    // Default mode shows the dark theme's own accent.
    expect(swatch.style.background).toBe("rgb(136, 192, 208)");
    expect(await save(user, onSave)).toMatchObject({ accentMode: "default" });
  });

  it("checks the system accent into system mode", async () => {
    const { user, onSave } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    await user.click(screen.getByRole("checkbox", { name: "Use the system accent color" }));
    expect(await save(user, onSave)).toMatchObject({ accentMode: "system" });
  });

  it("commits a picked colour as a custom accent, with Default giving the theme's accent", async () => {
    const { user, onSave } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    // A light UI theme makes the Cool slate blue the default.
    await user.click(card("UI theme", "Light"));
    await user.click(screen.getByRole("button", { name: "Choose custom accent color" }));
    const hex = screen.getByRole("textbox", { name: "Accent color hex" }) as HTMLInputElement;
    await user.clear(hex);
    await user.type(hex, "#123456");
    const popover = hex.closest(".accent-popover") as HTMLElement;
    await user.click(within(popover).getByRole("button", { name: "Default" }));
    expect(hex.value).toBe("#0969da");
    expect(hex.value).not.toBe("#0067c0");

    await user.clear(hex);
    await user.type(hex, "#123456");
    await user.click(within(popover).getByRole("button", { name: "OK" }));
    expect(await save(user, onSave)).toMatchObject({ accentMode: "custom", accentColor: "#123456" });
  });
});

describe("SettingsDialogView updates", () => {
  type Listener = (info: UpdateInfo) => void;

  /** A desktop bridge that answers the update commands and lets a test send
   *  update-changed events. */
  function desktop(info: UpdateInfo) {
    const listeners = new Set<Listener>();
    const invoke = vi.fn(async (command: string) => {
      if (command === "update_info") return info;
      if (command === "restart_to_update") throw new Error("No downloaded update is waiting.");
      return null;
    });
    const openExternal = vi.fn(async () => {});
    window.downpadDesktop = {
      platform: "linux",
      invoke,
      openExternal,
      listen: (_event: string, handler: Listener) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    } as unknown as NonNullable<typeof window.downpadDesktop>;
    const send = (next: UpdateInfo) => act(() => listeners.forEach((listener) => listener(next)));
    return { invoke, openExternal, send };
  }

  const installed: UpdateInfo = { version: "1.2.0", selfUpdate: true, lastCheckMs: null, state: { status: "idle" } };

  afterEach(() => {
    delete window.downpadDesktop;
  });

  it("saves the automatic update switch of a copy that installs updates itself", async () => {
    desktop(installed);
    const { user, onSave } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    expect(await screen.findByText("Current version: 1.2.0")).toBeTruthy();
    const automatic = await screen.findByRole("checkbox", { name: "Update automatically" });
    expect((automatic as HTMLInputElement).checked).toBe(true);
    await user.click(automatic);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ autoUpdate: false });
  });

  it("follows a check through its download to Restart now", async () => {
    const bridge = desktop(installed);
    const { user } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    const check = await screen.findByRole("button", { name: "Check for updates" });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    await user.click(check);
    expect(bridge.invoke).toHaveBeenCalledWith("check_for_updates", undefined);

    bridge.send({ ...installed, state: { status: "downloading", version: "1.3.0", percent: 42 } });
    expect(screen.getByRole("status").textContent).toBe("Downloading Downpad 1.3.0… 42%");
    expect((check as HTMLButtonElement).disabled).toBe(true);

    bridge.send({ ...installed, lastCheckMs: Date.UTC(2026, 9, 25, 12), state: { status: "ready", version: "1.3.0" } });
    expect(screen.getByRole("status").textContent).toBe("Downpad 1.3.0 is ready. It installs the next time Downpad starts.");
    expect(screen.getByText(/^Last checked /)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(bridge.invoke).toHaveBeenCalledWith("restart_to_update", undefined);
    // The main process refused, and the page says why.
    expect(await screen.findByText("No downloaded update is waiting.")).toBeTruthy();
  });

  /** Open Settings > Updates and click Check for updates. */
  async function checkForUpdates(bridge: ReturnType<typeof desktop>, restartIfSaved: () => Promise<boolean>) {
    const { user } = renderDialog(DEFAULT_SETTINGS, restartIfSaved);
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    const check = await screen.findByRole("button", { name: "Check for updates" });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    await user.click(check);
    expect(bridge.invoke).toHaveBeenCalledWith("check_for_updates", undefined);
    return { user, check };
  }

  const ready: UpdateInfo = { ...installed, state: { status: "ready", version: "1.3.0" } };

  it("restarts to install the download that the check ends with", async () => {
    const bridge = desktop(installed);
    const restartIfSaved = vi.fn(async () => true);
    await checkForUpdates(bridge, restartIfSaved);
    bridge.send({ ...installed, state: { status: "checking" } });
    bridge.send({ ...installed, state: { status: "downloading", version: "1.3.0", percent: 100 } });
    expect(restartIfSaved).not.toHaveBeenCalled();
    bridge.send(ready);
    expect(restartIfSaved).toHaveBeenCalledOnce();
    // Later news of the same download restarts nothing more.
    bridge.send(ready);
    expect(restartIfSaved).toHaveBeenCalledOnce();
  });

  it("keeps Restart now when the restart would lose unsaved documents", async () => {
    const bridge = desktop(installed);
    const restartIfSaved = vi.fn(async () => false);
    const { user } = await checkForUpdates(bridge, restartIfSaved);
    bridge.send(ready);
    expect(restartIfSaved).toHaveBeenCalledOnce();
    await user.click(await screen.findByRole("button", { name: "Restart now" }));
    expect(bridge.invoke).toHaveBeenCalledWith("restart_to_update", undefined);
  });

  it("does not restart while the form has changes that Save has not written", async () => {
    const bridge = desktop(installed);
    const restartIfSaved = vi.fn(async () => true);
    const { user } = renderDialog(DEFAULT_SETTINGS, restartIfSaved);
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await user.click(await screen.findByRole("checkbox", { name: "Update automatically" }));
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    bridge.send(ready);
    expect(restartIfSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
  });

  it("does not restart for a download that was ready before the check, or a check that found nothing", async () => {
    const bridge = desktop(ready);
    const restartIfSaved = vi.fn(async () => true);
    const { user } = renderDialog(DEFAULT_SETTINGS, restartIfSaved);
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeTruthy();
    // An automatic download that ends while Settings is open is not the user's check either.
    bridge.send({ ...installed, state: { status: "downloading", version: "1.3.0", percent: 50 } });
    bridge.send(ready);
    expect(restartIfSaved).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    bridge.send({ ...installed, state: { status: "up-to-date" } });
    bridge.send(ready);
    expect(restartIfSaved).not.toHaveBeenCalled();
  });

  it("offers the download page to a copy that cannot install updates, and keeps its saved switch", async () => {
    const bridge = desktop({ ...installed, selfUpdate: false });
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, autoUpdate: false });
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await screen.findByText("Current version: 1.2.0");
    expect(screen.queryByRole("checkbox", { name: "Update automatically" })).toBeNull();

    bridge.send({ ...installed, selfUpdate: false, state: { status: "available", version: "1.3.0", pageUrl: "https://github.com/lincarl/downpad/releases/tag/v1.3.0" } });
    expect(screen.getByRole("status").textContent).toBe("Downpad 1.3.0 is available.");
    await user.click(screen.getByRole("button", { name: "Open download page" }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://github.com/lincarl/downpad/releases/tag/v1.3.0");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ autoUpdate: false });
  });
});
