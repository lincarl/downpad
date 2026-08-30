// @vitest-environment jsdom
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
    clear: vi.fn(),
    focusEditor: vi.fn(),
  };
}

describe("FindBar", () => {
  it("is permanently visible and focuses the existing field for find and replace", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const controls = controller();
    active = new FindBar(parent, controls);

    const bar = parent.querySelector<HTMLElement>(".find-bar")!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelectorAll(".find-btn")).toHaveLength(4);
    expect(bar.querySelectorAll('.find-toggle input[type="checkbox"]')).toHaveLength(2);

    active.show("replace");

    expect(bar.querySelectorAll(".find-btn-text")).toHaveLength(2);
    expect(parent.querySelector<HTMLInputElement>('input[placeholder="Find in document"]')).toBe(
      document.activeElement,
    );

    active.close();
    expect(bar.hidden).toBe(false);
    expect(controls.clear).toHaveBeenCalledOnce();
    expect(controls.focusEditor).toHaveBeenCalledOnce();
  });
});
