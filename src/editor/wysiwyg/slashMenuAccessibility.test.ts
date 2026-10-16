// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installSlashMenuAccessibility } from "./slashMenuAccessibility";

/** A Crepe editor with its slash menu closed and "Text" highlighted, laid out as
 *  Crepe 7.22 renders it. */
function crepeRoot(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="milkdown">
      <div class="ProseMirror" contenteditable="true" role="textbox"><p>/</p></div>
      <div class="milkdown-slash-menu" data-show="false"><div>
        <nav class="tab-group"><ul><li class="selected">Text</li><li>List</li></ul></nav>
        <div class="menu-groups">
          <div class="menu-group"><h6>Text</h6><ul>
            <li data-index="0" class="hover"><span class="milkdown-icon"><svg></svg></span><span>Text</span></li>
            <li data-index="1" class=""><span class="milkdown-icon"><svg></svg></span><span>Heading 1</span></li>
          </ul></div>
          <div class="menu-group"><h6>List</h6><ul>
            <li data-index="2" class=""><span class="milkdown-icon"><svg></svg></span><span>Bullet List</span></li>
          </ul></div>
        </div>
      </div></div>
    </div>`;
  document.body.append(root);
  return root;
}

/** Let the menu's observer run. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  document.body.replaceChildren();
});

/** Watch `root`'s slash menu until the test ends. */
function install(root: HTMLElement): void {
  stops.push(installSlashMenuAccessibility(root));
}

describe("installSlashMenuAccessibility", () => {
  it("exposes the slash menu as grouped options and points the editor at the highlight while open", async () => {
    const root = crepeRoot();
    install(root);
    const editor = root.querySelector(".ProseMirror")!;
    const menu = root.querySelector<HTMLElement>(".milkdown-slash-menu")!;
    const list = root.querySelector(".menu-groups")!;
    const options = [...root.querySelectorAll("li[data-index]")];

    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.getAttribute("aria-label")).toBe("Insert block");
    expect([...root.querySelectorAll(".menu-group")].map((group) => [group.getAttribute("role"), group.getAttribute("aria-label")]))
      .toEqual([["group", "Text"], ["group", "List"]]);
    expect([...root.querySelectorAll(".menu-group h6")].every((caption) => caption.getAttribute("aria-hidden") === "true")).toBe(true);
    expect([...root.querySelectorAll(".menu-group ul")].every((items) => items.getAttribute("role") === "none")).toBe(true);
    expect(options.map((option) => [option.getAttribute("role"), option.getAttribute("aria-selected")]))
      .toEqual([["option", "true"], ["option", "false"], ["option", "false"]]);
    // Crepe keeps the highlight while the menu is closed. The editor must not
    // point at it then.
    expect(editor.hasAttribute("aria-activedescendant")).toBe(false);
    expect(editor.hasAttribute("aria-controls")).toBe(false);

    menu.dataset.show = "true";
    await observed();
    expect(editor.getAttribute("aria-controls")).toBe(list.id);
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    // ArrowDown moves Crepe's highlight to the next item.
    options[0]!.className = "";
    options[1]!.className = "hover";
    await observed();
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(new Set(options.map((option) => option.id)).size).toBe(3);

    menu.dataset.show = "false";
    await observed();
    expect(editor.hasAttribute("aria-activedescendant")).toBe(false);
    expect(editor.hasAttribute("aria-controls")).toBe(false);
  });

  it("marks up options Crepe adds as the filter changes, and clears the editor if the menu goes away", async () => {
    const root = crepeRoot();
    install(root);
    const editor = root.querySelector(".ProseMirror")!;
    const menu = root.querySelector<HTMLElement>(".milkdown-slash-menu")!;
    menu.dataset.show = "true";
    const added = document.createElement("li");
    added.dataset.index = "3";
    added.className = "hover";
    root.querySelector(".menu-group:last-child ul")!.append(added);
    root.querySelector('li[data-index="0"]')!.className = "";
    await observed();
    expect(added.getAttribute("role")).toBe("option");
    expect(editor.getAttribute("aria-activedescendant")).toBe(added.id);

    menu.remove();
    await observed();
    expect(editor.hasAttribute("aria-activedescendant")).toBe(false);
    expect(editor.hasAttribute("aria-controls")).toBe(false);
  });

  it("takes its attributes off the editor when it stops, even with the menu open", async () => {
    const root = crepeRoot();
    const stop = installSlashMenuAccessibility(root);
    root.querySelector<HTMLElement>(".milkdown-slash-menu")!.dataset.show = "true";
    await observed();
    const editor = root.querySelector(".ProseMirror")!;
    expect(editor.getAttribute("aria-activedescendant")).not.toBeNull();
    stop();
    expect(editor.hasAttribute("aria-controls")).toBe(false);
    expect(editor.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("gives each editor's menu its own ids", () => {
    const first = crepeRoot();
    const second = crepeRoot();
    install(first);
    install(second);
    const ids = [first, second].flatMap((root) => [...root.querySelectorAll("[id]")].map((element) => element.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });
});
