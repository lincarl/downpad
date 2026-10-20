// @vitest-environment jsdom
// shiftPressesAsClicks drops the browser's selection before the browser
// handles a Shift+press inside an element from an editor outside what was
// pressed, so Chromium takes the press as a plain click. pagePressesKeepFocus
// cancels a press on the page around the editors, so focus stays where it
// was. These tests check when each acts and when it leaves the press alone.

import { afterEach, describe, expect, it } from "vitest";
import { pagePressesKeepFocus, shiftPressesAsClicks } from "./pagePresses";

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

  it("leaves the selection when the CodeMirror editor whose content has focus holds the press, as on a fold arrow", () => {
    const { element, target } = setUp();
    element.innerHTML = [
      '<div class="cm-editor"><div class="cm-scroller">',
      '<div class="cm-gutters"><div class="cm-gutter cm-foldGutter"><div class="cm-gutterElement"><span>⌄</span></div></div></div>',
      '<div class="cm-content" contenteditable="true" tabindex="0"><div class="cm-line"># One</div></div>',
      "</div></div>",
    ].join("");
    element.append(target);
    const content = element.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    document.getSelection()!.collapse(content.querySelector(".cm-line")!.firstChild, 5);
    expect(press(element.querySelector(".cm-foldGutter span")!)).toBe(true);
    expect(press(target)).toBe(false);
  });

  it("drops the selection for a press elsewhere in the document view while a button in it has focus", () => {
    const { element, target } = setUp();
    element.innerHTML = '<div class="ProseMirror" contenteditable="true"><p>Text</p><div contenteditable="false"><button>Copy</button></div></div>';
    element.querySelector(".ProseMirror")!.append(target);
    element.querySelector("button")!.focus();
    document.getSelection()!.collapse(element.querySelector("p")!.firstChild, 2);
    expect(press(target)).toBe(false);
  });
});

describe("pagePressesKeepFocus", () => {
  /** An editor area with a column around a document view and a CodeMirror
   *  editor, a frontmatter table and a divider beside them. */
  function area() {
    const element = document.createElement("div");
    element.innerHTML = [
      '<div class="column"><div class="pane">',
      '<div class="frontmatter"><span class="caption">Frontmatter</span></div>',
      '<div class="milkdown"><div class="ProseMirror" contenteditable="true"><p>Text</p></div><div class="toolbar"></div></div>',
      "</div>",
      '<div class="divider" tabindex="0"></div>',
      '<div class="pane"><div class="cm-editor"><div class="cm-gutters"></div></div></div></div>',
    ].join("");
    document.body.append(element);
    stop = pagePressesKeepFocus(element);
    return element;
  }

  /** Press `target` with `button` and return whether the press was cancelled. */
  function cancelled(target: Element, button = 0): boolean {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("cancels a press on the area or an element that holds an editor, outside the editor", () => {
    const element = area();
    expect(cancelled(element)).toBe(true);
    expect(cancelled(element.querySelector(".column")!)).toBe(true);
    for (const pane of element.querySelectorAll(".pane")) expect(cancelled(pane)).toBe(true);
    expect(cancelled(element.querySelector(".milkdown")!)).toBe(true);
  });

  it("leaves a press inside an editor, on another element or with another button", () => {
    const element = area();
    for (const selector of [".ProseMirror", "p", ".cm-editor", ".cm-gutters", ".caption", ".toolbar", ".divider"]) {
      expect(cancelled(element.querySelector(selector)!), selector).toBe(false);
    }
    expect(cancelled(element.querySelector(".column")!, 2)).toBe(false);
  });
});
