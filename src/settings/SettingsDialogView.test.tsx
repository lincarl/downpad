// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialogView } from "./SettingsDialogView";

function renderDialog(initial: Settings = DEFAULT_SETTINGS) {
  const onSave = vi.fn<(next: Settings) => void>();
  const onRequestClose = vi.fn();
  render(<SettingsDialogView initial={initial} onSave={onSave} onRequestClose={onRequestClose} />);
  return { onSave, onRequestClose, user: userEvent.setup() };
}

/** A theme card's radio inside the named picker ("UI theme" or "Document theme"). */
const card = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

const checkedValue = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

afterEach(() => cleanup());

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
