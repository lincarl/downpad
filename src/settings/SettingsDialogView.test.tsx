// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "@/ipc/contracts";
import type { Settings } from "@/state/types";
import { createAppStore } from "@/app/createAppStore";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsDialogView } from "./SettingsDialogView";
import { withRecentLimit } from "./settingsChanges";

function renderDialog(initial: Settings = DEFAULT_SETTINGS) {
  const onSave = vi.fn<(changes: Partial<Settings>) => Promise<Partial<Settings> | null>>(async (changes) => changes);
  const onRequestClose = vi.fn();
  render(
    <SettingsDialogView initial={initial} saved={initial} onSave={onSave} onRequestClose={onRequestClose} />,
  );
  return { onSave, onRequestClose, user: userEvent.setup({ delay: null }) };
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

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    // Only the changed fields go to the save, so untouched fields on every
    // page keep their values.
    expect(onSave.mock.calls[0][0]).toEqual({
      theme: "light",
      editorTheme: "follow-ui",
      editorWidthPx: 800,
      mdBulletChar: "*",
      recentFilesDefaultSearch: "all",
      recentFilesKeepRemoved: true,
    });
    expect(onRequestClose).toHaveBeenCalled();
  });

  /** Every setting changed from its default, including those the dialog does not show. */
  const customized: Settings = {
    theme: "light",
    editorTheme: "dark",
    accentMode: "custom",
    accentColor: "#ff8800",
    editorWidthMode: "fill",
    editorWidthPx: 900,
    fontFamily: "Georgia",
    editorFontScale: 1.25,
    attachmentsFolderName: "assets",
    embedImagesAsBase64: false,
    maxEmbedSizeKB: 512,
    linkDisplay: "text-only",
    recentFilesMaxRetained: 50,
    recentFilesVisibleCount: 20,
    recentFilesDefaultSearch: "contents",
    recentFilesKeepRemoved: true,
    defaultView: "split",
    collapseBase64InRawView: false,
    spellCheckEnabled: false,
    spellCheckLanguages: ["de-DE"],
    showFrontmatterPanel: false,
    maxRetainedTabEditors: 3,
    mdBulletChar: "+",
    mdEmphasisChar: "_",
    mdStrongChar: "__",
    mdHeadingStyle: "setext",
    mdHardWrap: 72,
    autosaveEnabled: true,
    autosaveIntervalSeconds: 60,
    recoverySnapshotIntervalSeconds: 20,
    recoveryRetentionDays: 3,
    printVersion: "markdown",
    printPaperSize: "letter",
    printOrientation: "landscape",
    printMargins: "narrow",
    printScalePercent: 90,
    printHeaderTitle: true,
    printHeaderDate: true,
    printFooterPageNumbers: false,
    printerName: "Office",
    printCopies: 2,
    hasSeenWelcome: true,
    hasCheckedDefaultHandler: true,
    autoUpdate: false,
    gitEnabled: false,
    gitAutoGetLatest: false,
    gitUploadOnSave: true,
  };

  it.each([
    ["the defaults", DEFAULT_SETTINGS],
    ["customized settings", customized],
  ])("reads %s back unchanged, so OK without changes saves nothing and Apply stays disabled", async (_name, initial) => {
    const { user, onSave, onRequestClose } = renderDialog(initial);
    // A field that read back another way would count as a change.
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("offers OK, Cancel and Apply, with Apply enabled only while something differs from the saved settings", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    const footer = screen.getByRole("button", { name: "Apply" }).parentElement!;
    expect(within(footer).getAllByRole("button").map((button) => button.textContent)).toEqual(["OK", "Cancel", "Apply"]);
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    const keepRemoved = screen.getByRole("checkbox", { name: "Keep removed files in list" });
    await user.click(keepRemoved);
    expect(apply.disabled).toBe(false);
    // Changing it back leaves nothing to apply.
    await user.click(keepRemoved);
    expect(apply.disabled).toBe(true);

    // Apply saves and keeps the dialog open, and has nothing more to apply.
    const width = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
    await user.clear(width);
    await user.type(width, "12");
    expect(apply.disabled).toBe(false);
    await user.click(apply);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0]).toEqual({ recentFilesVisibleCount: 12 });
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(apply.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));

    // A later change goes in with OK, as the change since Apply.
    await user.click(keepRemoved);
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0]).toEqual({ recentFilesKeepRemoved: true });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("enables Apply for a change kept in the dialog's state, such as the accent colour", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    await user.click(screen.getByRole("checkbox", { name: "Use the system accent color" }));
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes on Cancel after Apply without saving the changes made since", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    const keepRemoved = screen.getByRole("checkbox", { name: "Keep removed files in list" });
    await user.click(keepRemoved);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Default search:" }), "all");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0]).toEqual({ recentFilesKeepRemoved: true });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("takes a saved value that the form shows otherwise for no change", async () => {
    const { user, onSave, onRequestClose } = renderDialog({
      ...DEFAULT_SETTINGS,
      autosaveEnabled: true,
      autosaveIntervalSeconds: 7200,
      accentMode: "custom",
      accentColor: "#FF8800",
      editorFontScale: 1.125,
    });
    // A hand-edited interval above the field's range shows as it is saved.
    expect(document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!.value).toBe("7200");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("shows a hand-edited text size as it is saved, and keeps it in an emptied field", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, editorFontScale: 2.504 });
    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    const size = document.querySelector<HTMLInputElement>('input[name="editorFontScalePct"]')!;
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(size.value).toBe("250.4");
    await user.clear(size);
    expect(apply.disabled).toBe(true);
    await user.type(size, "250");
    expect(apply.disabled).toBe(false);
    await user.click(apply);
    expect(onSave.mock.calls[0][0]).toEqual({ editorFontScale: 2.5 });
  });

  it("saves the field's largest value over a saved value above its range", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, autosaveEnabled: true, autosaveIntervalSeconds: 7200 });
    const interval = document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!;
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    await user.clear(interval);
    await user.type(interval, "3600");
    expect(apply.disabled).toBe(false);
    await user.click(apply);
    expect(onSave.mock.calls[0][0]).toEqual({ autosaveIntervalSeconds: 3600 });

    // Typed back to the saved value, the field reads as no change.
    await waitFor(() => expect(apply.disabled).toBe(true));
    await user.clear(interval);
    await user.type(interval, "3600");
    expect(apply.disabled).toBe(true);
  });

  it("shows the saved values in the fields after Apply", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, autosaveEnabled: true });
    const interval = document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!;
    const visible = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
    await user.clear(interval);
    await user.type(interval, "2");
    await user.clear(visible);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    // The emptied field kept its value, so only the interval changed.
    expect(onSave.mock.calls[0][0]).toEqual({ autosaveIntervalSeconds: 5 });
    // The number brought into range, and the value the emptied field kept.
    await waitFor(() => expect(interval.value).toBe("5"));
    expect(visible.value).toBe(String(DEFAULT_SETTINGS.recentFilesVisibleCount));
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a setting as saved where the save changed it, such as fewer recent files shown", async () => {
    const { user, onSave } = renderDialog();
    // The app shows no more recent files than it keeps.
    onSave.mockImplementationOnce(async (changes) => ({ ...changes, recentFilesVisibleCount: 10 }));
    const visible = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
    const retained = document.querySelector<HTMLInputElement>('input[name="recentFilesMaxRetained"]')!;
    await user.clear(retained);
    await user.type(retained, "10");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    await user.click(apply);
    expect(onSave.mock.calls[0][0]).toEqual({ recentFilesMaxRetained: 10 });
    await waitFor(() => expect(apply.disabled).toBe(true));
    expect(visible.value).toBe("10");
  });

  it("keeps an edit made while OK saves, and stays open for it", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    let finish!: () => void;
    onSave.mockImplementationOnce((changes) => new Promise((resolve) => (finish = () => resolve(changes))));
    const visible = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
    await user.click(screen.getByRole("checkbox", { name: "Keep removed files in list" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    await user.clear(visible);
    await user.type(visible, "40");
    await act(async () => finish());
    expect(onRequestClose).not.toHaveBeenCalled();
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    await user.click(apply);
    expect(onSave.mock.calls[1][0]).toEqual({ recentFilesVisibleCount: 40 });
  });

  it("leaves a field edited while Apply saves as the user typed it", async () => {
    const { user, onSave } = renderDialog();
    let finish!: () => void;
    onSave.mockImplementationOnce((changes) => new Promise((resolve) => (finish = () => resolve(changes))));
    const visible = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
    await user.clear(visible);
    await user.type(visible, "12");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    await user.click(apply);
    await user.clear(visible);
    await user.type(visible, "40");
    await act(async () => finish());
    expect(visible.value).toBe("40");
    await waitFor(() => expect(apply.disabled).toBe(false));
  });

  it("says so and keeps Apply on when the settings cannot be written, and OK keeps the dialog open", async () => {
    const { user, onSave, onRequestClose } = renderDialog();
    onSave.mockResolvedValue(null);
    await user.click(screen.getByRole("checkbox", { name: "Keep removed files in list" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save the settings file.");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onRequestClose).not.toHaveBeenCalled();

    // Once the file can be written, Apply saves the same change.
    onSave.mockImplementation(async (changes) => changes);
    await user.click(apply);
    await waitFor(() => expect(apply.disabled).toBe(true));
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(onSave.mock.calls[2][0]).toMatchObject({ recentFilesKeepRemoved: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves an out-of-range number on a hidden page clamped to its range", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, autosaveEnabled: true });
    const interval = document.querySelector<HTMLInputElement>('input[name="autosaveIntervalSeconds"]')!;
    await user.clear(interval);
    await user.type(interval, "2");
    await user.click(screen.getByRole("tab", { name: "Appearance" }));

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].autosaveIntervalSeconds).toBe(5);
  });

  it("saves a decimal number as a whole number, as settings.toml requires", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, mdHardWrap: 80 });
    await user.click(screen.getByRole("tab", { name: "Markdown" }));
    const column = document.querySelector<HTMLInputElement>('input[name="hardWrapCol"]')!;
    await user.clear(column);
    await user.type(column, "72.6");
    await user.click(screen.getByRole("button", { name: "OK" }));
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
    await user.click(screen.getByRole("button", { name: "OK" }));
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

describe("SettingsDialogView Git", () => {
  afterEach(() => {
    delete window.downpadDesktop;
  });

  it("keeps Git on its own page and preserves automatic choices when disabled", async () => {
    window.downpadDesktop = {
      platform: "linux",
      invoke: vi.fn(async () => null),
      listen: () => () => {},
    } as unknown as NonNullable<typeof window.downpadDesktop>;
    const { user, onSave } = renderDialog();
    expect(screen.queryByRole("checkbox", { name: "Get latest automatically" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Git" }));
    await user.keyboard("{Enter}");
    const enabled = screen.getByRole("checkbox", { name: "Enable Git" }) as HTMLInputElement;
    expect(document.activeElement).toBe(enabled);
    const getLatest = screen.getByRole("checkbox", { name: "Get latest automatically" }) as HTMLInputElement;
    const uploadOnSave = screen.getByRole("checkbox", { name: "Upload when saving" }) as HTMLInputElement;
    expect([enabled.checked, getLatest.checked, uploadOnSave.checked]).toEqual([true, true, false]);
    await user.click(getLatest);
    await user.click(uploadOnSave);
    await user.click(enabled);
    expect(getLatest.disabled).toBe(true);
    expect(uploadOnSave.disabled).toBe(true);
    await user.click(enabled);
    expect(getLatest.disabled).toBe(false);
    expect(uploadOnSave.disabled).toBe(false);
    expect([getLatest.checked, uploadOnSave.checked]).toEqual([false, true]);
    await user.click(enabled);
    await user.click(screen.getByRole("tab", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ gitEnabled: false, gitAutoGetLatest: false, gitUploadOnSave: true });
  });

  it("keeps the saved Git switches in a browser, which shows none", async () => {
    const { user, onSave } = renderDialog({ ...DEFAULT_SETTINGS, gitEnabled: false, gitAutoGetLatest: false, gitUploadOnSave: true });
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Upload when saving" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Keep removed files in list" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave.mock.calls.at(-1)?.[0]).toEqual({ recentFilesKeepRemoved: true });
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
    await user.click(screen.getByRole("button", { name: "OK" }));
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
    // Download completion leaves the restart decision to the desktop prompt.
    expect(bridge.invoke).not.toHaveBeenCalledWith("restart_to_update", undefined);
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(bridge.invoke).toHaveBeenCalledWith("restart_to_update", undefined);
    // The main process refused, and the page says why.
    expect(await screen.findByText("No downloaded update is waiting.")).toBeTruthy();
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

    await user.click(screen.getByRole("tab", { name: "General" }));
    await user.click(screen.getByRole("checkbox", { name: "Keep removed files in list" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave.mock.calls.at(-1)?.[0]).toEqual({ recentFilesKeepRemoved: true });
  });
});

describe("SettingsDialog", () => {
  it("saves only the dialog's changes, and a late OK leaves a newer dialog open", async () => {
    const store = createAppStore();
    let finish!: (written: Settings | null) => void;
    const onSave = vi.fn((_changes: Partial<Settings>) => new Promise<Settings | null>((resolve) => (finish = resolve)));
    const dialog = new SettingsDialog(store, onSave);
    // Radix lets presses reach the dialog once its effects have run.
    act(() => dialog.open());
    try {
      const user = userEvent.setup({ delay: null });
      // A hand edit of settings.toml arrives while the dialog is open, and
      // the save leaves it alone.
      act(() => store.set((state) => ({ settings: { ...state.settings, editorWidthPx: 900 } })));
      await user.click(screen.getByRole("checkbox", { name: "Keep removed files in list" }));
      await user.click(screen.getByRole("button", { name: "OK" }));
      expect(onSave).toHaveBeenCalledExactlyOnceWith({ recentFilesKeepRemoved: true });

      // Closed and opened again before that save ends.
      act(() => dialog.close());
      act(() => dialog.open());
      await act(async () => finish({ ...store.get().settings, recentFilesKeepRemoved: true }));
      expect(dialog.isOpen()).toBe(true);
    } finally {
      act(() => dialog.close());
    }
  });

  it("follows settings that change in the app while it is open, except fields the user changed", async () => {
    const store = createAppStore();
    const onSave = vi.fn(async (changes: Partial<Settings>) => {
      const next = { ...store.get().settings, ...changes };
      store.set({ settings: next });
      return next;
    });
    const dialog = new SettingsDialog(store, onSave);
    act(() => dialog.open());
    try {
      const user = userEvent.setup({ delay: null });
      const field = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      await user.click(screen.getByRole("tab", { name: "Appearance" }));
      await user.clear(field("editorWidthPx"));
      await user.type(field("editorWidthPx"), "1000");
      // A hand edit of settings.toml arrives.
      act(() => store.set((state) => ({ settings: {
        ...state.settings,
        editorWidthPx: 900,
        linkDisplay: "text-only",
        recentFilesKeepRemoved: true,
        recentFilesMaxRetained: 50,
        theme: "light",
      } })));
      expect(field("editorWidthPx").value).toBe("1000");
      expect(document.querySelector<HTMLSelectElement>('select[name="linkDisplay"]')!.value).toBe("text-only");
      expect(field("recentFilesKeepRemoved").checked).toBe(true);
      expect(field("recentFilesMaxRetained").value).toBe("50");
      expect((card("UI theme", "Light") as HTMLInputElement).checked).toBe(true);

      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(onSave).toHaveBeenCalledExactlyOnceWith({ editorWidthPx: 1000 });
    } finally {
      act(() => dialog.close());
    }
  });

  it("shows the recent files numbers as the file holds them after a save", async () => {
    const store = createAppStore();
    let file: Settings = { ...DEFAULT_SETTINGS, recentFilesMaxRetained: 10, recentFilesVisibleCount: 10 };
    store.set({ settings: file });
    // The main process puts the changes onto the file and keeps shown at
    // most kept.
    const onSave = vi.fn(async (changes: Partial<Settings>) => (file = withRecentLimit({ ...file, ...changes })));
    const dialog = new SettingsDialog(store, onSave);
    act(() => dialog.open());
    try {
      const user = userEvent.setup({ delay: null });
      const visible = document.querySelector<HTMLInputElement>('input[name="recentFilesVisibleCount"]')!;
      const retained = document.querySelector<HTMLInputElement>('input[name="recentFilesMaxRetained"]')!;
      const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
      // settings.toml keeps more history now, which the dialog still shows as 10.
      file = { ...file, recentFilesMaxRetained: 50 };
      act(() => store.set({ settings: file }));
      await user.clear(visible);
      await user.type(visible, "20");
      await user.click(apply);
      expect(onSave.mock.calls[0][0]).toEqual({ recentFilesVisibleCount: 20 });
      await waitFor(() => expect(apply.disabled).toBe(true));
      expect([visible.value, retained.value]).toEqual(["20", "50"]);

      // Keeping fewer than are shown shows fewer too.
      await user.clear(retained);
      await user.type(retained, "15");
      await user.click(apply);
      expect(onSave.mock.calls[1][0]).toEqual({ recentFilesMaxRetained: 15 });
      await waitFor(() => expect(apply.disabled).toBe(true));
      expect([visible.value, retained.value]).toEqual(["15", "15"]);
    } finally {
      act(() => dialog.close());
    }
  });
});
