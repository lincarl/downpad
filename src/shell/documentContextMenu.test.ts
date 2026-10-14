// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildItems, type DocumentMenuActions } from "./documentContextMenu";
import type { EditableTarget } from "./editorActions";
import type { MenuItem } from "./contextMenu";

function actions(overrides: Partial<DocumentMenuActions> = {}): DocumentMenuActions {
  return {
    hasDocument: () => true,
    print: () => {},
    copyMarkdown: () => {},
    insertLink: () => true,
    ...overrides,
  };
}

/**
 * An editable to right-click, with `selected` standing in for the browser
 * selection — jsdom never reports one, and `hasSelection` checks that the
 * selection anchor is *inside* the editable, so the stub has to anchor there.
 */
function target(kind: EditableTarget["kind"], selected = ""): EditableTarget {
  const el = document.createElement("div");
  document.body.appendChild(el);
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: selected === "",
    anchorNode: el,
    toString: () => selected,
  } as unknown as Selection);
  return { el, kind };
}

const labels = (items: MenuItem[]): string[] => items.map((i) => i.label);
const byLabel = (items: MenuItem[], label: string): MenuItem =>
  items.find((i) => i.label === label)!;

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("buildItems", () => {
  it("offers only the document actions off an editable, and exactly one Print entry", () => {
    const items = buildItems(null, actions());
    expect(labels(items)).toEqual(["Copy as Markdown", "Print…"]);
    // The version choice lives in the print workspace, never as a submenu here.
    expect(items.filter((i) => i.label.startsWith("Print"))).toHaveLength(1);
  });

  it("disables the document actions when nothing is open", () => {
    const items = buildItems(null, actions({ hasDocument: () => false }));
    expect(byLabel(items, "Print…").disabled).toBe(true);
    expect(byLabel(items, "Copy as Markdown").disabled).toBe(true);
  });

  it("adds the editing commands over editable text", () => {
    const items = buildItems(target("wysiwyg"), actions());
    expect(labels(items)).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "Paste as plain text",
      "Insert link…",
      "Select all",
      "Copy as Markdown",
      "Print…",
    ]);
  });

  it("greys out the selection-dependent commands when nothing is selected", () => {
    const items = buildItems(target("wysiwyg"), actions());
    expect(byLabel(items, "Cut").disabled).toBe(true);
    expect(byLabel(items, "Copy").disabled).toBe(true);
    expect(byLabel(items, "Insert link…").disabled).toBe(true);
    // Paste can't be checked synchronously, so it is never greyed out.
    expect(byLabel(items, "Paste").disabled).toBeUndefined();
    expect(byLabel(items, "Select all").disabled).toBeUndefined();
  });

  it("enables cut/copy/link once there is a selection", () => {
    const items = buildItems(target("wysiwyg", "some words"), actions());
    expect(byLabel(items, "Cut").disabled).toBe(false);
    expect(byLabel(items, "Copy").disabled).toBe(false);
    expect(byLabel(items, "Insert link…").disabled).toBe(false);
  });

  it("keeps Insert link off the Markdown source pane, where a link mark has no meaning", () => {
    const items = buildItems(target("raw", "some words"), actions());
    expect(byLabel(items, "Insert link…").disabled).toBe(true);
    expect(byLabel(items, "Cut").disabled).toBe(false);
  });

  it("routes Print and Copy as Markdown to the shell", () => {
    const print = vi.fn();
    const copyMarkdown = vi.fn();
    const items = buildItems(null, actions({ print, copyMarkdown }));
    byLabel(items, "Print…").run();
    byLabel(items, "Copy as Markdown").run();
    expect(print).toHaveBeenCalledOnce();
    expect(copyMarkdown).toHaveBeenCalledOnce();
  });
});

describe("installDocumentContextMenu", () => {
  /** Fire a bubbling, cancelable contextmenu and report what happened. */
  function rightClick(el: Element, init: MouseEventInit = {}): { prevented: boolean; menu: boolean } {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return {
      prevented: ev.defaultPrevented,
      menu: document.querySelector(".md-context-menu") !== null,
    };
  }

  beforeEach(async () => {
    document.querySelector(".md-context-menu")?.remove();
    const { installDocumentContextMenu } = await import("./documentContextMenu");
    installDocumentContextMenu(actions());
  });

  it("replaces the native menu everywhere in the app", () => {
    const chrome = document.createElement("button");
    document.body.appendChild(chrome);
    const result = rightClick(chrome);
    expect(result.prevented).toBe(true);
    expect(result.menu).toBe(true);
  });

  it("lets Shift+right-click through so Chromium spell-check suggestions survive (§5.14)", () => {
    const editable = document.createElement("div");
    editable.className = "ProseMirror";
    document.body.appendChild(editable);
    const result = rightClick(editable, { shiftKey: true });
    expect(result.prevented).toBe(false); // native menu opens instead
    expect(result.menu).toBe(false);
  });

  it("defers to a menu that already handled the click (images, tabs, Recent rows)", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    row.addEventListener("contextmenu", (e) => e.preventDefault());
    expect(rightClick(row).menu).toBe(false);
  });
});
