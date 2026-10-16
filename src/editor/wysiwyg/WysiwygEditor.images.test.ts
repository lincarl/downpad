// @vitest-environment jsdom
// Crepe's image views render a node's raw src until proxyDomURL answers, and
// Chromium looks a raw relative src up next to md-easy's own page. These tests
// use the real editor to check that local images start at the URL they show
// and that a late answer never replaces a newer one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";

const native = vi.hoisted(() => ({
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
}));
vi.mock("../../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/bridge")>()),
  convertFileSrc: native.convertFileSrc,
}));

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
