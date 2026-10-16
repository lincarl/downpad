import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Waits until the open modal dialog accepts pointer input. Call it before the
 * first click or type in a dialog that a test opened outside `render`.
 *
 * Radix sets `pointer-events: none` on the body as a modal dialog mounts and
 * gives the dialog `pointer-events: auto` one React render later. React runs
 * that render as a scheduled task, so on a busy machine it can land after the
 * test's first click, and user-event throws on a pointer action at an element
 * with `pointer-events: none`.
 */
export async function waitForDialogPointerInput(): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(getComputedStyle(dialog).pointerEvents, "the dialog's pointer-events").not.toBe("none"),
  );
}
