// @vitest-environment jsdom
import { act } from "react";
import { fireEvent } from "@testing-library/react";
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

describe("FindBar", () => {
  it("opens as a card for find and replace and closes back to the document", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const controls = controller();
    const openChanges: boolean[] = [];
    active = new FindBar(parent, controls, (open) => openChanges.push(open));

    const bar = parent.querySelector<HTMLElement>(".find-bar")!;
    expect(bar.hidden).toBe(true);
    expect(active.isOpen()).toBe(false);
    expect(bar.querySelectorAll(".find-btn")).toHaveLength(4);
    expect(bar.querySelectorAll('.find-toggle input[type="checkbox"]')).toHaveLength(2);

    active.show("replace");

    expect(bar.hidden).toBe(false);
    expect(active.isOpen()).toBe(true);
    expect(bar.querySelector<HTMLElement>(".find-replace-row")!.hidden).toBe(false);
    expect(bar.querySelectorAll(".find-btn-text")).toHaveLength(2);
    expect(parent.querySelector<HTMLInputElement>('input[placeholder="Find in document"]')).toBe(
      document.activeElement,
    );

    active.close();
    expect(bar.hidden).toBe(true);
    expect(active.isOpen()).toBe(false);
    expect(controls.clear).toHaveBeenCalledOnce();
    expect(controls.focusEditor).toHaveBeenCalledOnce();
    expect(openChanges).toEqual([true, false]);
  });

  it("toggles from the toolbar and closes on Escape from any control", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const controls = controller();
    active = new FindBar(parent, controls);

    active.toggle();
    expect(active.isOpen()).toBe(true);
    const toggle = parent.querySelector<HTMLInputElement>('.find-toggle input[type="checkbox"]')!;
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(active.isOpen()).toBe(false);
    expect(controls.focusEditor).toHaveBeenCalledOnce();

    active.toggle();
    active.toggle();
    expect(active.isOpen()).toBe(false);
  });

  it("shows the count an edit leaves while it is open with a query", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const controls = controller();
    active = new FindBar(parent, controls);
    const count = parent.querySelector(".find-count")!;

    // An empty field has no count to update.
    active.show("find");
    active.syncCounts();
    expect(controls.counts).not.toHaveBeenCalled();

    vi.mocked(controls.search).mockReturnValue({ current: 1, total: 2 });
    fireEvent.change(parent.querySelector('input[placeholder="Find in document"]')!, { target: { value: "zeta" } });
    expect(count.textContent).toBe("1 of 2");

    // Typing a third match in the document.
    vi.mocked(controls.counts).mockReturnValue({ current: 1, total: 3 });
    act(() => active!.syncCounts());
    expect(count.textContent).toBe("1 of 3");

    // A closed card keeps its query but shows no count.
    active.close();
    act(() => active!.syncCounts());
    expect(controls.counts).toHaveBeenCalledOnce();
  });
});
