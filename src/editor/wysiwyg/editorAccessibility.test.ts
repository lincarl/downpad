// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { installEditorAccessibility } from "./editorAccessibility";

describe("installEditorAccessibility", () => {
  it("labels Crepe editables and table controls", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="ProseMirror" role="textbox"></div>
      <div class="cm-content" role="textbox"></div>
      <div data-role="x-line-drag-handle"><button class="add-button"></button></div>
      <div data-role="y-line-drag-handle"><button class="add-button"></button></div>
    `;

    const dispose = installEditorAccessibility(root);
    expect(root.querySelector(".ProseMirror")?.getAttribute("aria-label")).toBe("Document editor");
    expect(root.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Code block editor");
    expect(root.querySelector('[data-role="x-line-drag-handle"] button')?.getAttribute("aria-label"))
      .toBe("Add table column");
    expect(root.querySelector('[data-role="y-line-drag-handle"] button')?.getAttribute("aria-label"))
      .toBe("Add table row");

    const later = document.createElement("div");
    later.className = "cm-content";
    root.append(later);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(later.getAttribute("aria-label")).toBe("Code block editor");
    dispose();
  });
});
