// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { waitForDialogPointerInput } from "@/components/ui/dialog-test-utils";
import { openConflictDialog } from "./ConflictDialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("openConflictDialog", () => {
  const options = { fileName: "notes.md", author: "Anna Berg", timeMs: Date.now() - 2 * 60 * 60_000 };

  it("says who changed the document and focuses Decide later, so typing chooses nothing else", async () => {
    const user = userEvent.setup();
    const choice = openConflictDialog(options);
    const later = await screen.findByRole("button", { name: "Decide later" });
    await waitFor(() => expect(document.activeElement).toBe(later));
    expect(screen.getByRole("dialog").textContent).toContain("Anna Berg changed “notes.md” 2 hours ago");
    await user.keyboard(" ");
    expect(await choice).toBe("later");
  });

  it("resolves the chosen action", async () => {
    const user = userEvent.setup();
    const choice = openConflictDialog(options);
    await waitForDialogPointerInput();
    await user.click(await screen.findByRole("button", { name: "Save mine as…" }));
    expect(await choice).toBe("save-as");
    await waitFor(() => expect(document.querySelector("[data-react-conflict-dialog]")).toBeNull());
  });
});
