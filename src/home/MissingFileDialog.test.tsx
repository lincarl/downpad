// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openMissingFileDialog } from "./MissingFileDialog";

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
});

describe("openMissingFileDialog", () => {
  it("activates the focused action when Enter is pressed", async () => {
    const result = openMissingFileDialog("gone.md");
    const user = userEvent.setup();
    const remove = screen.getByRole("button", { name: "Remove from history" });

    remove.focus();
    await user.keyboard("{Enter}");

    await expect(result).resolves.toBe("remove");
  });

  it("puts Locate last with initial focus, and Escape cancels", async () => {
    const result = openMissingFileDialog("gone.md");
    const user = userEvent.setup();

    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Remove from history", "Cancel", "Locate"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Locate" }));

    await user.keyboard("{Escape}");
    await expect(result).resolves.toBe("cancel");
  });

  it("can be cancelled by its owning Recent view", async () => {
    const controller = new AbortController();
    const result = openMissingFileDialog("gone.md", controller.signal);

    controller.abort();

    await expect(result).resolves.toBe("cancel");
    expect(document.querySelector(".missing-dialog")).toBeNull();
  });
});
