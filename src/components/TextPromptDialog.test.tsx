// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { openTextPrompt } from "./TextPromptDialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("openTextPrompt", () => {
  it("focuses and selects the initial value, then resolves the submitted text", async () => {
    const user = userEvent.setup();
    const result = openTextPrompt({
      title: "Insert link",
      label: "Link URL",
      initialValue: "https://",
      confirmLabel: "Insert",
    });

    const input = await screen.findByRole("textbox", { name: "Link URL" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe("https://".length);

    await user.type(input, "example.com");
    await user.click(screen.getByRole("button", { name: "Insert" }));

    expect(await result).toBe("https://example.com");
    await waitFor(() => expect(document.querySelector("[data-react-text-prompt]")).toBeNull());
  });

  it("resolves null when cancelled", async () => {
    const user = userEvent.setup();
    const result = openTextPrompt({ title: "Edit alt text", label: "Alt text" });

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(await result).toBeNull();
  });
});
