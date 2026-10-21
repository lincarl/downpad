// @vitest-environment jsdom
// shiftPressesAsClicks drops the browser's selection before the browser
// handles a Shift+press inside an element from an editor outside what was
// pressed, so Chromium takes the press as a plain click. pagePressesKeepFocus
// cancels a press on the page around the editors, so focus stays where it
// was, and hands one below an editor's end on to the editor. These tests
// check when each acts and when it leaves the press alone.

import { afterEach, describe, expect, it } from "vitest";
import { pagePressesKeepFocus, shiftPressesAsClicks } from "./pagePresses";

// jsdom has no isContentEditable. An element is editable here when the
// nearest element with a contenteditable attribute does not set it to false.
Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
  configurable: true,
  get(this: HTMLElement) {
    const host = this.closest("[contenteditable]");
    return !!host && host.getAttribute("contenteditable") !== "false";
  },
});

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
  outside.setAttribute("contenteditable", "true");
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

  it("drops the selection of an editor outside while a button has focus", () => {
    const { outside, element, target } = setUp();
    const button = document.createElement("button");
    element.append(button);
    button.focus();
    // Chromium keeps the selection in the editor, where jsdom moves it.
    document.getSelection()!.collapse(outside.firstChild, 4);
    expect(press(target)).toBe(false);
  });

  it("drops the selection of a focused text field, which Chromium reports at the field's place", () => {
    const { target } = setUp();
    const field = document.createElement("input");
    document.body.prepend(field);
    field.focus();
    document.getSelection()!.collapse(document.body, 0);
    expect(document.activeElement).toBe(field);
    expect(press(target)).toBe(false);
  });

  it("leaves a selection in text that cannot be edited, also while nothing has focus", () => {
    const { outside, element } = setUp();
    const text = document.createElement("pre");
    text.textContent = "# First comment second comment";
    element.append(text);
    outside.blur();
    document.getSelection()!.collapse(text.firstChild, 4);
    expect(document.activeElement).toBe(document.body);
    expect(press(text)).toBe(true);
  });

  it("drops the selection of an editor while nothing has focus", () => {
    const { outside, target } = setUp();
    outside.blur();
    document.getSelection()!.collapse(outside.firstChild, 4);
    expect(document.activeElement).toBe(document.body);
    expect(press(target)).toBe(false);
  });
});

describe("pagePressesKeepFocus", () => {
  /** An editor area with a column around a hidden pane, a pane with a
   *  frontmatter table and a document view that holds a code block, a
   *  divider, and a pane with a CodeMirror editor. */
  function area() {
    const element = document.createElement("div");
    element.innerHTML = [
      '<div class="column">',
      '<div class="pane" hidden><div class="ProseMirror" contenteditable="true"><p>Other tab</p></div></div>',
      '<div class="pane">',
      '<div class="frontmatter"><span class="caption">Frontmatter</span></div>',
      '<div class="milkdown"><div class="ProseMirror" contenteditable="true"><p>Text</p>',
      '<div class="cm-editor"><div class="cm-content"></div></div></div><div class="toolbar"></div></div>',
      "</div>",
      '<div class="divider" tabindex="0"></div>',
      '<div class="pane"><div class="cm-editor"><div class="cm-gutters"></div><div class="cm-content"></div></div></div></div>',
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

  /** Lay `element` out from the top of the page down to `bottom`, with
   *  `padding` inside its bottom edge, since jsdom lays nothing out. */
  function show(element: HTMLElement, bottom: number, padding = 0): void {
    const box = { top: 0, bottom, left: 0, right: 100, width: 100, height: bottom, x: 0, y: 0 } as DOMRect;
    element.getBoundingClientRect = () => box;
    element.getClientRects = () => [box] as unknown as DOMRectList;
    Object.defineProperty(element, "clientHeight", { configurable: true, value: bottom });
    element.style.paddingBottom = `${padding}px`;
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

  it("hands a press below the end of the editor a column or pane shows on to it, at the same point", () => {
    const element = area();
    const [, documentPane, markdownPane] = element.querySelectorAll<HTMLElement>(".pane");
    const documentView = documentPane!.querySelector<HTMLElement>(".ProseMirror")!;
    const markdown = markdownPane!.querySelector<HTMLElement>(".cm-editor")!;
    // The document view's last block ends at 80, above its bottom padding.
    show(documentView, 100, 20);
    show(markdown, 200);
    const received: MouseEvent[] = [];
    for (const pressed of [documentView, documentView.querySelector<HTMLElement>(".cm-content")!, markdown.querySelector<HTMLElement>(".cm-content")!]) {
      pressed.addEventListener("mousedown", (event) => received.push(event));
    }
    const press = (target: Element, clientY: number, shiftKey = false) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 30, clientY, shiftKey, detail: 1 });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      return received.splice(0);
    };
    // Below the last block, beside the padding or below the view, on the
    // column or the pane. The copy does not bubble, so only the view sees it.
    const [copy, ...more] = press(element.querySelector(".column")!, 90, true);
    expect(more).toEqual([]);
    expect(copy).toMatchObject({ target: documentView, clientX: 30, clientY: 90, shiftKey: true, button: 0, detail: 1, bubbles: false });
    expect(press(documentPane!, 150).map((event) => event.target)).toEqual([documentView]);
    // Beside the view's text, or beside the column at any height, the press
    // only keeps focus where it was.
    expect(press(documentPane!, 80)).toEqual([]);
    expect(press(element, 150)).toEqual([]);
    // Below a CodeMirror editor, its content takes the press.
    expect(press(markdownPane!, 250).map((event) => event.target)).toEqual([markdown.querySelector(".cm-content")]);
    expect(press(markdownPane!, 200)).toEqual([]);
  });
});
