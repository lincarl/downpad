// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { waitForDialogPointerInput } from "@/components/ui/dialog-test-utils";
import type { Snapshot } from "@/ipc/contracts";
import { RecoveryDialog, type RecoveryHandlers } from "./RecoveryDialog";

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const older: Snapshot = {
  sessionId: "older",
  savedAt: minutesAgo(90),
  filePath: "/notes/plan.md",
  markdown: "---\ntitle: Plan\n---\n\n# Project plan\n\n> Ship it\n",
  isDirty: true,
};
const newer: Snapshot = {
  sessionId: "newer",
  savedAt: minutesAgo(2),
  filePath: null,
  markdown: "Meeting summary\n",
  isDirty: true,
};

function handlers(): RecoveryHandlers {
  return { openRecovered: vi.fn(), openOriginal: vi.fn(), discard: vi.fn() };
}

const names = (): string[] =>
  Array.from(document.querySelectorAll(".recovery-item-name"), (node) => node.textContent ?? "");

afterEach(() => {
  document.body.replaceChildren();
});

describe("RecoveryDialog", () => {
  it("keeps a cancelled original open available for recovery", async () => {
    const dialog = new RecoveryDialog();
    const actions = handlers();
    actions.openOriginal = vi.fn(async () => false);
    const closed = dialog.open([older], actions);
    const user = userEvent.setup();
    try {
      await waitForDialogPointerInput();
      await user.click(screen.getByRole("button", { name: "Open original" }));
      expect(document.querySelector(".recovery-dialog")).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Open recovered" }));
      await closed;
      expect(actions.openRecovered).toHaveBeenCalledExactlyOnceWith(older);
    } finally { dialog.destroy(); }
  });

  it("retains a snapshot row when discarding fails and allows a later retry", async () => {
    const dialog = new RecoveryDialog();
    const actions = handlers();
    actions.discard = vi.fn().mockRejectedValueOnce(new Error("Disk busy")).mockResolvedValue(undefined);
    const closed = dialog.open([newer], actions);
    const user = userEvent.setup();
    try {
      await waitForDialogPointerInput();
      await user.click(screen.getByRole("button", { name: "Discard" }));
      expect((await screen.findByRole("alert")).textContent).toBe("Could not discard the recovered work. Please try again.");
      expect(names()).toEqual(["Untitled document"]);
      await user.click(screen.getByRole("button", { name: "Discard" }));
      await closed;
      expect(actions.discard).toHaveBeenCalledTimes(2);
    } finally { dialog.destroy(); }
  });

  it("shows an original-open error and keeps recovered text available without an unhandled rejection", async () => {
    const dialog = new RecoveryDialog();
    const actions = handlers();
    actions.openOriginal = vi.fn(async () => { throw new Error("File is missing"); });
    const closed = dialog.open([older], actions);
    const user = userEvent.setup();
    try {
      await waitForDialogPointerInput();
      await user.click(screen.getByRole("button", { name: "Open original" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(
        "Could not open the original file. Your recovered work is still available.",
      ));
      expect(document.querySelector(".recovery-dialog")).not.toBeNull();
      expect(actions.openRecovered).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Open recovered" }));
      await closed;
      expect(actions.openRecovered).toHaveBeenCalledExactlyOnceWith(older);
      await waitFor(() => expect(document.querySelector(".recovery-dialog")).toBeNull());
    } finally { dialog.destroy(); }
  });

  it("blocks competing actions while an original open is pending and allows retry after failure", async () => {
    const dialog = new RecoveryDialog();
    const actions = handlers();
    let fail!: (reason: Error) => void;
    actions.openOriginal = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(undefined);
    const closed = dialog.open([older, newer], actions);
    const user = userEvent.setup();
    try {
      await waitForDialogPointerInput();
      await user.click(screen.getByRole("button", { name: "Open original" }));
      expect(screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
      fail(new Error("Temporarily unavailable"));
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: "Open original" }));
      await closed;
      expect(actions.openOriginal).toHaveBeenCalledTimes(2);
    } finally { dialog.destroy(); }
  });

  it("lists snapshots newest first with a plain-text preview and ignores Escape", async () => {
    const dialog = new RecoveryDialog();
    void dialog.open([older, newer], handlers());
    const user = userEvent.setup();

    expect(names()).toEqual(["Untitled document", "plan.md"]);
    const path = document.querySelector(".recovery-item-path");
    expect(path?.getAttribute("title")).toBe("/notes/plan.md");
    expect(path?.textContent).toContain("/notes/plan.md");
    const previews = Array.from(document.querySelectorAll(".recovery-item-preview"), (node) => node.textContent);
    expect(previews).toEqual(["Meeting summary", "Project plan · Ship it"]);

    await user.keyboard("{Escape}");
    expect(document.querySelector(".recovery-dialog")).not.toBeNull();
    dialog.destroy();
  });

  it("closes once the last snapshot is discarded", async () => {
    const dialog = new RecoveryDialog();
    const actions = handlers();
    const closed = dialog.open([newer], actions);
    const user = userEvent.setup();

    await waitForDialogPointerInput();
    await user.click(screen.getByRole("button", { name: "Discard" }));

    await closed;
    expect(actions.discard).toHaveBeenCalledWith(newer);
    await waitFor(() => expect(document.querySelector(".recovery-dialog")).toBeNull());
  });
});
