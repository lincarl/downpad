// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installEditorAccessibility } from "./editorAccessibility";

/** Let the observer handle the latest DOM changes. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

/** A Crepe root holding `html`, watched by installEditorAccessibility. */
function install(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  dispose = installEditorAccessibility(root);
  return root;
}

const attr = (root: HTMLElement, selector: string, name: string) => root.querySelector(selector)?.getAttribute(name);

describe("installEditorAccessibility", () => {
  it("hides drawn icons and pointer-only controls from screen readers and the Tab key", () => {
    const icon = '<span class="milkdown-icon"><svg></svg></span>';
    const root = install(`
      <div class="milkdown">
        <div class="ProseMirror">
          <div class="milkdown-list-item-block"><div class="label-wrapper">
            <span class="milkdown-icon label checked"><svg role="img" aria-label="Done"></svg></span>
          </div></div>
          <div class="milkdown-table-block">
            <div class="handle cell-handle" data-role="col-drag-handle">${icon}
              <div class="button-group"><button class="align">${icon}</button></div>
            </div>
            <div class="handle line-handle" data-role="x-line-drag-handle"><button class="add-button">${icon}</button></div>
          </div>
          <div class="milkdown-image-block"><div class="operation"><div class="operation-item">${icon}</div></div></div>
          <div class="milkdown-code-block"><button class="copy-button">${icon}Copy</button></div>
        </div>
        <div class="milkdown-block-handle"><div class="operation-item">${icon}</div></div>
        <div class="milkdown-slash-menu"><nav class="tab-group"><ul><li>Text</li></ul></nav></div>
        <div class="milkdown-latex-inline-edit"><div class="container"><button class="confirm">${icon}</button></div></div>
      </div>
    `);

    for (const hidden of [
      ".milkdown-table-block .cell-handle",
      ".milkdown-table-block .line-handle",
      ".milkdown-image-block .operation",
      ".milkdown-block-handle",
      ".milkdown-slash-menu .tab-group",
      ".milkdown-latex-inline-edit button",
    ]) {
      expect(attr(root, hidden, "aria-hidden"), hidden).toBe("true");
    }
    for (const button of ["button.align", "button.add-button", "button.confirm"]) {
      expect(root.querySelector<HTMLButtonElement>(button)?.tabIndex, button).toBe(-1);
    }
    // The add buttons have no name to get wrong. The x-line one adds a row.
    expect(attr(root, "button.add-button", "aria-label")).toBeNull();
    // A visible button keeps its place in the Tab order, and only its icon is hidden.
    expect(root.querySelector<HTMLButtonElement>("button.copy-button")?.tabIndex).toBe(0);
    expect(attr(root, "button.copy-button", "aria-hidden")).toBeNull();
    expect(attr(root, "button.copy-button svg", "aria-hidden")).toBe("true");
    // An icon with a name is information, not decoration.
    expect(attr(root, ".label svg", "aria-hidden")).toBeNull();
  });

  it("labels only the main editor, the math field and the image link field", async () => {
    const root = install(`
      <div class="milkdown">
        <div class="ProseMirror">
          <div class="milkdown-image-block"><input class="link-input-area"></div>
          <p><span class="milkdown-image-inline"><input class="link-input-area"></span></p>
        </div>
        <div class="milkdown-latex-inline-edit"><div class="container"><div><div class="ProseMirror"></div></div></div></div>
      </div>
    `);

    expect(attr(root, ".milkdown > .ProseMirror", "aria-label")).toBe("Document editor");
    expect(attr(root, ".milkdown-latex-inline-edit .ProseMirror", "aria-label")).toBe("Math formula");
    expect(attr(root, ".milkdown-latex-inline-edit .ProseMirror", "role")).toBe("textbox");
    for (const field of root.querySelectorAll(".link-input-area")) expect(field.getAttribute("aria-label")).toBe("Image link");

    // Code blocks and icons added later are handled too.
    const code = document.createElement("div");
    code.innerHTML = '<div class="cm-content"></div><span class="milkdown-icon"><svg></svg></span>';
    root.querySelector(".milkdown > .ProseMirror")?.append(code);
    await observed();
    expect(code.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Code block editor");
    expect(code.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("turns the code language list into a named list of options", async () => {
    const root = install(`
      <div class="milkdown-code-block">
        <button class="language-button">js</button>
        <div class="language-picker"></div>
      </div>
    `);
    expect(attr(root, ".language-button", "aria-description")).toBe("Code language");
    expect(attr(root, ".language-button", "aria-haspopup")).toBe("listbox");

    // Crepe draws the list when the picker opens.
    const picker = root.querySelector(".language-picker")!;
    picker.innerHTML = `
      <ul class="language-list" role="listbox">
        <li role="listitem" aria-selected="true">JavaScript</li>
        <li class="no-result">No result</li>
      </ul>
    `;
    await observed();
    expect(attr(root, ".language-list", "aria-label")).toBe("Code language");
    expect(attr(root, "li[aria-selected]", "role")).toBe("option");

    // Crepe reuses the "No result" row for a language when the filter changes.
    root.querySelector(".no-result")?.setAttribute("role", "listitem");
    await observed();
    expect(attr(root, ".no-result", "role")).toBe("option");
  });
});
