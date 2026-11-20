// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { capturePlace, keepingPlace, PlacesBehindRecent, restorePlace } from "./keepingPlace";

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

describe("a document's place", () => {
  it("is taken from the area and its panes, and put back onto the panes shown later", () => {
    const { editorArea } = area();
    const place = capturePlace(editorArea);
    expect([...place]).toEqual([["area", 10], ["wysiwyg", 200], ["raw", 300]]);
    const built = rebuild(editorArea);
    restorePlace(editorArea, place);
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([10, 200, 300]);
  });

  it("leaves a pane alone that the place has nothing for", () => {
    const { editorArea, raw } = area();
    raw.hidden = true;
    const place = capturePlace(editorArea);
    expect([...place.keys()]).toEqual(["area", "wysiwyg"]);
    raw.hidden = false;
    raw.scrollTop = 40;
    restorePlace(editorArea, place);
    expect(raw.scrollTop).toBe(40);
  });

  it("leaves a pane alone that is hidden by the time the place is put back", () => {
    const { editorArea, wysiwyg, raw } = area();
    const place = capturePlace(editorArea);
    raw.hidden = true;
    raw.scrollTop = 40;
    wysiwyg.scrollTop = 0;
    restorePlace(editorArea, place);
    expect([wysiwyg.scrollTop, raw.scrollTop]).toEqual([200, 40]);
  });
});

describe("the places of documents behind the Recent view", () => {
  it("puts a document's place back when it shows again, once, also in editors built meanwhile", () => {
    const { editorArea } = area();
    const places = new PlacesBehindRecent();
    places.take(editorArea, "a", ["a", "b"]);
    const built = rebuild(editorArea);
    places.giveBack(editorArea, "a", () => "a");
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([10, 200, 300]);
    // The next time the document shows, it is where the user left it.
    built.wysiwyg.scrollTop = 50;
    places.giveBack(editorArea, "a", () => "a");
    expect(built.wysiwyg.scrollTop).toBe(50);
  });

  it("keeps a document's place while another tab shows, and gives that tab none", () => {
    const { editorArea } = area();
    const places = new PlacesBehindRecent();
    places.take(editorArea, "a", ["a", "b"]);
    // The user leaves the Recent view for another tab, whose panes are at the top.
    let built = rebuild(editorArea);
    places.giveBack(editorArea, "b", () => "b");
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([0, 0, 0]);
    built = rebuild(editorArea);
    places.giveBack(editorArea, "a", () => "a");
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop, built.raw.scrollTop]).toEqual([10, 200, 300]);
  });

  it("takes the place for the tab whose editors show, not for one that is still being built", () => {
    const { editorArea } = area();
    const places = new PlacesBehindRecent();
    // The store's tab in front is "b" already, and the panes are still those of "a".
    places.take(editorArea, "a", ["a", "b"]);
    const built = rebuild(editorArea);
    places.giveBack(editorArea, "b", () => "b");
    expect(built.wysiwyg.scrollTop).toBe(0);
  });

  it("forgets the place of a tab that was closed, and takes none when no editors show", () => {
    const { editorArea } = area();
    const places = new PlacesBehindRecent();
    places.take(editorArea, "a", ["a"]);
    places.take(editorArea, null, []);
    const built = rebuild(editorArea);
    places.giveBack(editorArea, "a", () => "a");
    places.giveBack(editorArea, null, () => null);
    expect([editorArea.scrollTop, built.wysiwyg.scrollTop]).toEqual([0, 0]);
  });
});

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
