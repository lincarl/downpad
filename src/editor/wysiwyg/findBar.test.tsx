// @vitest-environment jsdom
import { act } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindBar, type FindController } from "./findBar";

let active: FindBar | null = null;

afterEach(async () => {
  active?.destroy();
  active = null;
  document.body.replaceChildren();
  await Promise.resolve();
});

function controller(): FindController {
  const counts = { current: 0, total: 0 };
  return {
    search: vi.fn(() => counts),
    next: vi.fn(() => counts),
    prev: vi.fn(() => counts),
    replaceCurrent: vi.fn(() => counts),
    replaceAll: vi.fn(() => counts),
    counts: vi.fn(() => counts),
    clear: vi.fn(),
    focusEditor: vi.fn(),
  };
}

/** Mount a find bar in a fresh parent element. */
function mount(controls: FindController, onOpenChange?: (open: boolean) => void): FindBar {
  const parent = document.createElement("div");
  document.body.append(parent);
  active = new FindBar(parent, controls, onOpenChange);
  return active;
}

const findField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Find in document" });
const checkbox = (name: string) => screen.getByRole<HTMLInputElement>("checkbox", { name });
/** The names of the card's visible buttons, in order. */
const buttonNames = () =>
  screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
/** The count the card announces, such as "1 of 2". */
const countText = () =>
  screen.getByRole("search", { name: "Find in document" }).querySelector("[aria-live]")?.textContent;

describe("FindBar", () => {
  it("opens as a card for find and replace and closes back to the document", () => {
    const controls = controller();
    const openChanges: boolean[] = [];
    const bar = mount(controls, (open) => openChanges.push(open));

    expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
    expect(bar.isOpen()).toBe(false);

    bar.show("find");
    expect(bar.isOpen()).toBe(true);
    expect(document.activeElement).toBe(findField());
    expect(buttonNames()).toEqual(["Previous match", "Next match", "Close find"]);
    expect(checkbox("Match case").checked).toBe(false);
    expect(checkbox("Whole word").checked).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull();

    bar.show("replace");
    expect(document.activeElement).toBe(findField());
    expect(screen.getByRole("textbox", { name: "Replace with" })).not.toBeNull();
    expect(buttonNames()).toEqual(["Previous match", "Next match", "Close find", "Replace", "Replace all"]);

    bar.close();
    expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
    expect(bar.isOpen()).toBe(false);
    expect(controls.clear).toHaveBeenCalledOnce();
    expect(controls.focusEditor).toHaveBeenCalledOnce();
    // Focus goes back before the search is cleared, while the editor still
    // knows which match is current.
    expect(vi.mocked(controls.focusEditor).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(controls.clear).mock.invocationCallOrder[0],
    );
    expect(openChanges).toEqual([true, false]);
  });

  it("toggles from the toolbar and closes on Escape from any control", () => {
    const controls = controller();
    const bar = mount(controls);

    bar.toggle();
    expect(bar.isOpen()).toBe(true);
    checkbox("Match case").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bar.isOpen()).toBe(false);
    expect(controls.focusEditor).toHaveBeenCalledOnce();

    bar.toggle();
    bar.toggle();
    expect(bar.isOpen()).toBe(false);
  });

  it("searches again with each option change and replaces and reopens with the options in use", () => {
    const controls = controller();
    // Fewer matches when case matters.
    vi.mocked(controls.search).mockImplementation((_query, opts) =>
      opts.caseSensitive ? { current: 1, total: 1 } : { current: 1, total: 3 },
    );
    const bar = mount(controls);
    bar.show("replace");
    fireEvent.change(findField(), { target: { value: "zeta" } });
    expect(controls.search).toHaveBeenLastCalledWith("zeta", { caseSensitive: false, wholeWord: false, regex: false });
    expect(countText()).toBe("1 of 3");

    fireEvent.click(checkbox("Match case"));
    expect(controls.search).toHaveBeenLastCalledWith("zeta", { caseSensitive: true, wholeWord: false, regex: false });
    expect(countText()).toBe("1 of 1");

    fireEvent.click(checkbox("Whole word"));
    const both = { caseSensitive: true, wholeWord: true, regex: false };
    expect(controls.search).toHaveBeenLastCalledWith("zeta", both);
    expect(controls.search).toHaveBeenCalledTimes(3);

    // Enter in the replace field replaces the current match.
    const replace = screen.getByRole("textbox", { name: "Replace with" });
    fireEvent.change(replace, { target: { value: "eta" } });
    expect(fireEvent.keyDown(replace, { key: "Enter" })).toBe(false);
    expect(controls.replaceCurrent).toHaveBeenCalledExactlyOnceWith("eta", "zeta", both);

    // The card keeps its query and options, and searches again when it reopens.
    bar.close();
    vi.mocked(controls.search).mockClear();
    act(() => bar.show("find"));
    expect(controls.search).toHaveBeenCalledExactlyOnceWith("zeta", both);
    expect(countText()).toBe("1 of 1");
    expect(checkbox("Match case").checked).toBe(true);
    expect(checkbox("Whole word").checked).toBe(true);
  });

  it("keeps focus in the card when replacing removes the last match", () => {
    const controls = controller();
    vi.mocked(controls.search).mockReturnValue({ current: 1, total: 2 });
    vi.mocked(controls.replaceCurrent).mockReturnValue({ current: 1, total: 1 });
    const bar = mount(controls);
    bar.show("replace");
    const find = findField();
    fireEvent.change(find, { target: { value: "zeta" } });
    const replace = screen.getByRole<HTMLButtonElement>("button", { name: "Replace" });
    const replaceAll = screen.getByRole<HTMLButtonElement>("button", { name: "Replace all" });

    // A match is left, so the button keeps focus.
    replace.focus();
    fireEvent.click(replace);
    expect(document.activeElement).toBe(replace);

    // No match is left, so Replace all is disabled and hands focus to the
    // find field before the browser can drop it to the page.
    replaceAll.focus();
    fireEvent.click(replaceAll);
    expect(replaceAll.disabled).toBe(true);
    expect(document.activeElement).toBe(find);
    fireEvent.keyDown(find, { key: "Escape" });
    expect(bar.isOpen()).toBe(false);
  });

  it("shows the count an edit leaves while it is open with a query", () => {
    const controls = controller();
    const bar = mount(controls);

    // An empty field has no count to update.
    bar.show("find");
    bar.syncCounts();
    expect(controls.counts).not.toHaveBeenCalled();

    vi.mocked(controls.search).mockReturnValue({ current: 1, total: 2 });
    fireEvent.change(findField(), { target: { value: "zeta" } });
    expect(countText()).toBe("1 of 2");

    // Typing a third match in the document.
    vi.mocked(controls.counts).mockReturnValue({ current: 1, total: 3 });
    act(() => bar.syncCounts());
    expect(countText()).toBe("1 of 3");

    // A closed card keeps its query but shows no count.
    bar.close();
    act(() => bar.syncCounts());
    expect(controls.counts).toHaveBeenCalledOnce();
  });
});
