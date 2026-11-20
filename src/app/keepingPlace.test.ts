// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { keepingPlace } from "./keepingPlace";

/** An editor area with a document pane and a Markdown pane, scrolled. */
function area(): { editorArea: HTMLElement; wysiwyg: HTMLElement; raw: HTMLElement } {
  const editorArea = document.createElement("div");
  const wysiwyg = document.createElement("div");
  wysiwyg.className = "editor-pane editor-pane-wysiwyg";
  const raw = document.createElement("div");
  raw.className = "editor-pane editor-pane-raw";
  editorArea.append(wysiwyg, raw);
  editorArea.scrollTop = 10;
  wysiwyg.scrollTop = 200;
  raw.scrollTop = 300;
  return { editorArea, wysiwyg, raw };
}

/** As a reload does: the panes start again at the top. */
const scrollToTop = (...panes: HTMLElement[]) => async () => {
  for (const pane of panes) pane.scrollTop = 0;
};

describe("keeping a reloaded document in place", () => {
  it("scrolls the new editors to where the old ones were", async () => {
    const { editorArea, wysiwyg, raw } = area();
    await keepingPlace(editorArea, () => "tab", scrollToTop(editorArea, wysiwyg, raw));
    expect([editorArea.scrollTop, wysiwyg.scrollTop, raw.scrollTop]).toEqual([10, 200, 300]);
  });

  it("scrolls nothing when another tab is in front once the reload ends", async () => {
    const { editorArea, wysiwyg, raw } = area();
    let inFront = "tab";
    await keepingPlace(editorArea, () => inFront, async () => {
      // The user shows another tab during the reload, whose panes are at the top.
      inFront = "other";
      await scrollToTop(editorArea, wysiwyg, raw)();
    });
    expect([editorArea.scrollTop, wysiwyg.scrollTop, raw.scrollTop]).toEqual([0, 0, 0]);
  });
});
