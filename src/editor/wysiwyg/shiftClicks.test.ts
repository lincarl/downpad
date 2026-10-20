// @vitest-environment jsdom
// shiftPressesAsClicks drops the browser's selection before the browser
// handles a Shift+press inside an element from an editor outside what was
// pressed, so Chromium takes the press as a plain click. These tests check
// when it does and when it leaves the selection alone.

import { afterEach, describe, expect, it } from "vitest";
import { shiftPressesAsClicks } from "./shiftClicks";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

/** A document with an outside editor holding a selection, and an element
 *  with a target to press inside it. */
function setUp() {
  const outside = document.createElement("div");
  outside.contentEditable = "true";
  outside.tabIndex = 0;
  outside.textContent = "Outside text";
  const element = document.createElement("div");
  const target = document.createElement("span");
  target.textContent = "Pressed";
  element.append(target);
  document.body.append(outside, element);
  stop = shiftPressesAsClicks(element);
  outside.focus();
  document.getSelection()!.collapse(outside.firstChild, 4);
  return { outside, element, target };
}

/** Press the primary button on `target`, with Shift unless `shiftKey` is
 *  false, and return whether the browser's selection is still there. */
function press(target: Element, shiftKey = true): boolean {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey }));
  return document.getSelection()!.rangeCount > 0;
}

describe("shiftPressesAsClicks", () => {
  it("drops the selection of the editor outside for a Shift+press", () => {
    const { target } = setUp();
    expect(press(target)).toBe(false);
  });

  it("leaves the selection for a press without Shift or with another button", () => {
    const { target } = setUp();
    expect(press(target, false)).toBe(true);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, shiftKey: true }));
    expect(document.getSelection()!.rangeCount).toBe(1);
  });

  it("leaves the selection for a press that a handler cancelled", () => {
    const { target } = setUp();
    target.addEventListener("mousedown", (event) => event.preventDefault());
    expect(press(target)).toBe(true);
  });

  it("leaves the selection for a press during which a handler moved focus", () => {
    const { target } = setUp();
    const other = document.createElement("input");
    document.body.append(other);
    target.addEventListener("mousedown", () => other.focus());
    expect(press(target)).toBe(true);
  });

  it("leaves the selection when the focused element holds the press", () => {
    const { element, target } = setUp();
    element.tabIndex = 0;
    element.focus();
    expect(press(target)).toBe(true);
  });
});
