// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialogView } from "./SettingsDialogView";

describe("SettingsDialogView accessibility", () => {
  afterEach(() => cleanup());

  it("describes the dialog and gives the accent picker independent button semantics", () => {
    render(
      <SettingsDialogView
        initial={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "Configure the editor appearance",
    );

    const accentButton = screen.getByRole("button", {
      name: "Choose custom accent color",
    });
    expect(accentButton.closest("label")).toBeNull();
    expect(accentButton.closest(".dialog-row")?.textContent).toContain("Custom accent");

    expect((document.querySelector('select[name="theme"]') as HTMLSelectElement).value).toBe(
      "dark",
    );
    expect(
      (document.querySelector('select[name="editorTheme"]') as HTMLSelectElement).value,
    ).toBe("light");
  });
});
