// @vitest-environment jsdom
// Crepe's image views render a node's raw src until proxyDomURL answers, and
// Chromium looks a raw relative src up next to md-easy's own page. These tests
// use the real editor to check that local images start at the URL they show.

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
});

afterEach(async () => {
  Object.defineProperty(HTMLImageElement.prototype, "src", srcProperty);
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on DOCUMENT, saved at /docs/a.md. */
async function open(): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, DOCUMENT, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => "/docs/a.md",
    requestSave: async () => false,
  });
  return root;
}

/** The src each image in the editor has now. */
const sources = (root: HTMLElement) => [...root.querySelectorAll("img")].map((image) => image.getAttribute("src"));

describe("preloadImages", () => {
  it("shows local images at their own URL from the first render", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(async (path) => (path === "/docs/pic.png" ? "md-easy-file://pic" : null));

    const root = await open();

    expect(sources(root)).toEqual(["md-easy-file://pic", "md-easy-file://pic", "data:,"]);
    // The raw paths would be requested next to md-easy's own page.
    expect(shownSources).not.toContain("pic.png");
    expect(shownSources).not.toContain("gone.png");
    expect(native.convertFileSrc).toHaveBeenCalledTimes(2);
  });

  it("shows the document when the main process is slow to answer", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();

    const root = await open();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(root.querySelectorAll("img")).toHaveLength(3);
  });
});
