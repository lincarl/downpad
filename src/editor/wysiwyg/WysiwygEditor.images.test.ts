// @vitest-environment jsdom
// Crepe's image views render a node's raw src until proxyDomURL answers, and
// Chromium looks a raw relative src up next to md-easy's own page. These tests
// use the real editor to check that local images start at the URL they show,
// that a late answer never replaces a newer one, and that a relocated image
// shows the file it is pointed at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";

const native = vi.hoisted(() => ({
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
  openDialog: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/bridge")>()),
  convertFileSrc: native.convertFileSrc,
}));
vi.mock("../../ipc/dialogs", () => ({ openDialog: native.openDialog }));

import { WysiwygEditor } from "./WysiwygEditor";
import { forgetImageAnswers } from "./imageView";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const DOCUMENT = "![Block](pic.png)\n\nInline ![inline](pic.png) and ![gone](gone.png).\n";

/** Every src an image element took, in order, including before it was shown. */
let shownSources: string[] = [];
const srcProperty = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
let editor: WysiwygEditor | null = null;

beforeEach(() => {
  shownSources = [];
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...srcProperty,
    set(this: HTMLImageElement, value: string) {
      shownSources.push(value);
      srcProperty.set!.call(this, value);
    },
  });
  native.convertFileSrc.mockReset();
  native.openDialog.mockReset();
  forgetImageAnswers();
});

afterEach(async () => {
  Object.defineProperty(HTMLImageElement.prototype, "src", srcProperty);
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Start mounting the document editor on `markdown`, saved at /docs/a.md. */
function start(markdown: string): { root: HTMLElement; mounting: Promise<void> } {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  const mounting = editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => "/docs/a.md",
    requestSave: async () => false,
  });
  return { root, mounting };
}

/** Mount the document editor on `markdown`, saved at /docs/a.md. */
async function open(markdown: string): Promise<HTMLElement> {
  const { root, mounting } = start(markdown);
  await mounting;
  return root;
}

/** The src each image in the editor has now. */
const sources = (root: HTMLElement) => [...root.querySelectorAll("img")].map((image) => image.getAttribute("src"));

describe("the first render", () => {
  it("shows local images at their own URL", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(async (path) => (path === "/docs/pic.png" ? "md-easy-file://pic" : null));

    const root = await open(DOCUMENT);

    expect(sources(root)).toEqual(["md-easy-file://pic", "md-easy-file://pic", "data:,"]);
    // The raw paths would be requested next to md-easy's own page.
    expect(shownSources).not.toContain("pic.png");
    expect(shownSources).not.toContain("gone.png");
    expect(native.convertFileSrc).toHaveBeenCalledTimes(2);
  });

  it("shows the document when the main process is slow to answer", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();

    const root = await open(DOCUMENT);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(root.querySelectorAll("img")).toHaveLength(3);
  });

  it("keeps a split mirror made while it waits for answers", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(() => new Promise(() => {}));
    const { root, mounting } = start(DOCUMENT);
    await vi.waitFor(() => expect(native.convertFileSrc).toHaveBeenCalled());

    // Markdown typed in the split while the document pane is still being built.
    editor!.setMarkdown("![Block](pic.png)\n\nNew text.\n");
    await mounting;

    expect(root.querySelector(".ProseMirror p")?.textContent).toBe("New text.");
    expect(editor!.getMarkdown()).toBe("![Block](pic.png)\n\nNew text.\n");
  });
});

describe("a late answer", () => {
  it("never replaces the answer for an image's newer src", { timeout: 60_000 }, async () => {
    let answerB: (url: string) => void = () => {};
    native.convertFileSrc.mockImplementation((path) =>
      path === "/docs/b.png" ? new Promise((resolve) => (answerB = resolve)) : Promise.resolve(`url ${path}`),
    );
    const root = await open("![](a.png)\n");

    // The Markdown pane changes the path while b.png's lookup is slow, then back.
    editor!.setMarkdown("![](b.png)\n");
    editor!.setMarkdown("![](a.png)\n");
    answerB("url /docs/b.png");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sources(root)).toEqual(["url /docs/a.png"]);
  });
});

describe("a relocated image", () => {
  it("shows the file it is pointed at, even the one it could not find before", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockResolvedValue(null);
    const root = await open("![Missing](pic.png)\n");
    const block = root.querySelector(".milkdown-image-block")!;
    const image = block.querySelector("img")!;
    // jsdom loads no images, so tell the view the empty source failed.
    image.dispatchEvent(new Event("error"));
    expect(block.classList).toContain("md-image-missing");

    // The file is put back, and the user picks it.
    native.convertFileSrc.mockResolvedValue("md-easy-file://pic");
    native.openDialog.mockResolvedValue("/docs/pic.png");
    block.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(image.getAttribute("src")).toBe("md-easy-file://pic"));
    image.dispatchEvent(new Event("load"));
    expect(block.classList).not.toContain("md-image-missing");
    // A click on the found image leaves it alone.
    block.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(native.openDialog).toHaveBeenCalledTimes(1);
  });
});
