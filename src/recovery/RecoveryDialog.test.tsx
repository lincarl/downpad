// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    await user.click(screen.getByRole("button", { name: "Discard" }));

    await closed;
    expect(actions.discard).toHaveBeenCalledWith(newer);
    await waitFor(() => expect(document.querySelector(".recovery-dialog")).toBeNull());
  });
});
