// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { captureFocus } from "./restoreFocus";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => document.body.replaceChildren());

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  document.body.append(element);
  return element;
}

describe("captureFocus", () => {
  it("returns focus to the opener after the dialog's host is removed", async () => {
    const opener = button("Open");
    opener.focus();
    const restore = captureFocus();
    const inDialog = button("Save");
    inDialog.focus();
    inDialog.remove();
    expect(document.activeElement).toBe(document.body);

    restore();
    await tick();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus that has moved elsewhere, and skips an opener that is gone", async () => {
    const opener = button("Open");
    opener.focus();
    const restore = captureFocus();
    const elsewhere = button("Elsewhere");
    elsewhere.focus();
    restore();
    await tick();
    expect(document.activeElement).toBe(elsewhere);

    elsewhere.focus();
    const restoreGone = captureFocus();
    elsewhere.remove();
    restoreGone();
    await tick();
    expect(document.activeElement).toBe(document.body);
  });
});
