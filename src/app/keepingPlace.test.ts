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

/** As a reload does: the area starts again at the top, with new panes in
 *  place of the old ones. Returns the new panes. */
function rebuild(editorArea: HTMLElement): { wysiwyg: HTMLElement; raw: HTMLElement } {
  editorArea.scrollTop = 0;
  const panes = [...editorArea.querySelectorAll<HTMLElement>(".editor-pane")].map((old) => {
    const pane = document.createElement("div");
    pane.className = old.className;
    old.replaceWith(pane);
    return pane;
  });
  return { wysiwyg: panes[0], raw: panes[1] };
}

describe("keeping a reloaded document in place", () => {
  it("scrolls the new editors to where the old ones were", async () => {
    const { editorArea } = area();
    let built!: ReturnType<typeof rebuild>;
    await keepingPlace(editorArea, () => "tab", async () => { built = rebuild(editorArea); });
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([10, 200, 300]);
  });

  it("scrolls nothing when another tab is in front once the reload ends", async () => {
    const { editorArea } = area();
    let inFront = "tab";
    let built!: ReturnType<typeof rebuild>;
    await keepingPlace(editorArea, () => inFront, async () => {
      // The user shows another tab during the reload, whose panes are at the top.
      inFront = "other";
      built = rebuild(editorArea);
    });
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([0, 0, 0]);
  });
});
