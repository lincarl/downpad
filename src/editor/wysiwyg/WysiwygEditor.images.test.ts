// @vitest-environment jsdom
// Crepe's image views render a node's raw src until proxyDomURL answers, and
// Chromium looks a raw relative src up next to Downpad's own page. These tests
// use the real editor to check that local images start at the URL they show,
// that a late answer never replaces a newer one, that a relocated image shows
// the file it is pointed at, that an image stored as a file through the upload
// input goes beside its document, and that the app takes pasted images.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";

const native = vi.hoisted(() => ({
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
  openDialog: vi.fn<() => Promise<string | null>>(),
  /** Gives the image's link from the document, as the main process does. */
  writeAttachment: vi.fn<(docPath: string, folder: string, name: string) => Promise<string>>(),
}));
vi.mock("../../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/bridge")>()),
  convertFileSrc: native.convertFileSrc,
}));
vi.mock("../../ipc/dialogs", () => ({ openDialog: native.openDialog }));
vi.mock("../../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/commands")>()),
  writeAttachment: native.writeAttachment,
}));

import { WysiwygEditor } from "./WysiwygEditor";
import type { WysiwygContext } from "./context";
import { ANSWER_WAIT_MS, forgetImageAnswers } from "./imageView";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

/** jsdom has no ClipboardEvent or DragEvent, which Crepe's upload plugin, the
 *  one that takes an image pasted alone, checks a paste for. */
class ClipboardEventStub extends Event {
  constructor(type: string, readonly clipboardData: Pick<DataTransfer, "files" | "items" | "getData">) {
    super(type, { bubbles: true, cancelable: true });
  }
}
vi.stubGlobal("ClipboardEvent", ClipboardEventStub);
vi.stubGlobal("DragEvent", class extends Event {});

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
  native.writeAttachment.mockReset();
  native.writeAttachment.mockImplementation(async (_docPath, folder) => `${folder}/img.png`);
  forgetImageAnswers();
});

afterEach(async () => {
  vi.useRealTimers();
  Object.defineProperty(HTMLImageElement.prototype, "src", srcProperty);
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Start mounting the document editor on `markdown`, saved at /docs/a.md
 *  unless `context` says otherwise. */
function start(
  markdown: string,
  onChange: (markdown: string) => void = () => {},
  context: Partial<WysiwygContext> = {},
): { root: HTMLElement; mounting: Promise<void> } {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  const mounting = editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => "/docs/a.md",
    requestSave: async () => false,
    ...context,
  });
  return { root, mounting };
}

/** Mount the document editor on `markdown`, saved at /docs/a.md unless
 *  `context` says otherwise. */
async function open(markdown: string, onChange?: (markdown: string) => void, context?: Partial<WysiwygContext>): Promise<HTMLElement> {
  const { root, mounting } = start(markdown, onChange, context);
  await mounting;
  return root;
}

/** The editor's ProseMirror view, for undo checks the public API cannot make. */
const viewOf = (opened: WysiwygEditor) =>
  (opened as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);

/** The src each image in the editor has now. */
const sources = (root: HTMLElement) => [...root.querySelectorAll("img")].map((image) => image.getAttribute("src"));

/** Fake the clock, timers and animation frames before a mount, so a test can
 *  pass the wait for answers (ANSWER_WAIT_MS) without waiting in real time. */
const fakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });

describe("the first render", () => {
  it("shows local images at their own URL", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(async (path) => (path === "/docs/pic.png" ? "downpad-file://pic" : null));

    const root = await open(DOCUMENT);

    expect(sources(root)).toEqual(["downpad-file://pic", "downpad-file://pic", "data:,"]);
    // The raw paths would be requested next to Downpad's own page.
    expect(shownSources).not.toContain("pic.png");
    expect(shownSources).not.toContain("gone.png");
    expect(native.convertFileSrc).toHaveBeenCalledTimes(2);
  });

  it("keeps a split mirror made while it waits for answers, and shows the document when the wait ends", { timeout: 60_000 }, async () => {
    fakeClock();
    native.convertFileSrc.mockImplementation(() => new Promise(() => {}));
    const started = performance.now();
    const { root, mounting } = start(DOCUMENT);
    let mounted = false;
    void mounting.then(() => (mounted = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.convertFileSrc).toHaveBeenCalled();

    // Markdown typed in the split while the document pane is still being built.
    editor!.setMarkdown("![Block](pic.png)\n\nNew text.\n");
    // The main process never answers. The first render waits ANSWER_WAIT_MS,
    // which the design keeps to a second at most.
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
    expect(mounted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(mounted).toBe(true);
    expect(performance.now() - started).toBeLessThanOrEqual(1_000);

    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector(".ProseMirror p")?.textContent).toBe("New text.");
    expect(editor!.getMarkdown()).toBe("![Block](pic.png)\n\nNew text.\n");
  });

  it("writes the text it opened with when undo takes back a split mirror made while it waits", { timeout: 60_000 }, async () => {
    fakeClock();
    native.convertFileSrc.mockImplementation(() => new Promise(() => {}));
    const opened = "![Block](pic.png)\n\nLine  \nnext.\n";
    const { mounting } = start(opened);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.convertFileSrc).toHaveBeenCalled();

    // The Markdown pane changes the paragraph while the document pane is still being built.
    editor!.setMarkdown(opened.replace("next.", "next, typed."));
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await mounting;
    const view = viewOf(editor!);
    undo(view.state, view.dispatch);

    // Milkdown would write the line break as a backslash.
    expect(editor!.getMarkdown()).toBe(opened);
  });
});

/** A PNG image file, as a screenshot or an image chosen in a file dialog. */
const pngFile = (): File => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });

/** A FileList holding `files`. */
const fileList = (files: File[]): FileList =>
  Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;

/** Paste a PNG image at the caret, as Ctrl+V does with a screenshot alone on
 *  the clipboard, or with `text` too. */
function pasteImage(root: HTMLElement, text = ""): void {
  const clipboard = {
    files: fileList([pngFile()]),
    items: [] as unknown as DataTransferItemList,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
  root.querySelector(".ProseMirror")!.dispatchEvent(new ClipboardEventStub("paste", clipboard));
}

/** Choose a PNG image in the upload input of the empty image block. */
function uploadImage(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>(".milkdown-image-block input[type=file]")!;
  Object.defineProperty(input, "files", { value: fileList([pngFile()]), configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("an image stored as a file through the upload input", () => {
  /** The settings that store every image as a file. */
  const asFiles = { getSettings: () => ({ ...DEFAULT_SETTINGS, embedImagesAsBase64: false }) };
  /** A document with an empty image block, which shows the upload input. */
  const EMPTY_IMAGE = "First line.\n\n![]()\n";

  it("starts at its own URL", { timeout: 60_000 }, async () => {
    let answer: (url: string) => void = () => {};
    native.convertFileSrc.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const root = await open(EMPTY_IMAGE, undefined, asFiles);

    uploadImage(root);
    await vi.waitFor(() => expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/attachments/img.png"));
    // The image goes in once the main process answers.
    expect(sources(root)).toEqual([]);
    answer("downpad-file://img");

    await vi.waitFor(() => expect(sources(root)).toEqual(["downpad-file://img"]));
    // The raw path would be requested next to Downpad's own page.
    expect(shownSources).not.toContain("attachments/img.png");
    expect(editor!.getMarkdown()).toContain("![](attachments/img.png)");
  });

  it("is written and looked up again beside the document when a Save As moves it while the image is looked up", { timeout: 60_000 }, async () => {
    let answerFirst: (url: string) => void = () => {};
    native.convertFileSrc.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    native.convertFileSrc.mockImplementation(async (path) => `downpad-file://${path}`);
    let filePath = "/docs/a.md";
    const root = await open(EMPTY_IMAGE, undefined, { ...asFiles, getFilePath: () => filePath });

    uploadImage(root);
    await vi.waitFor(() => expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/attachments/img.png"));
    // A Save As into another folder ends before the main process answers.
    filePath = "/moved/a.md";
    answerFirst("downpad-file:///docs/attachments/img.png");

    await vi.waitFor(() => expect(sources(root)).toEqual(["downpad-file:///moved/attachments/img.png"]));
    expect(native.writeAttachment).toHaveBeenCalledTimes(2);
    expect(native.writeAttachment).toHaveBeenLastCalledWith("/moved/a.md", "attachments", expect.stringMatching(/^img-/), expect.any(Uint8Array));
    expect(shownSources).not.toContain("attachments/img.png");
  });
});

describe("a pasted image", () => {
  it("goes to the app at once, and Crepe's upload plugin puts nothing into the editor", { timeout: 60_000 }, async () => {
    const pasteImages = vi.fn<(files: File[]) => void>();
    const root = await open("First line.\n", undefined, {
      getSettings: () => ({ ...DEFAULT_SETTINGS, embedImagesAsBase64: false }),
      pasteImages,
    });

    pasteImage(root);
    expect(pasteImages).toHaveBeenCalledOnce();
    expect(pasteImages.mock.calls[0]![0].map((file) => [file.name, file.type])).toEqual([["image.png", "image/png"]]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No upload placeholder, no image without a src, and no file written.
    expect(root.textContent).not.toContain("Upload in progress");
    expect(root.querySelector(".milkdown-image-block")).toBeNull();
    expect(editor!.getMarkdown()).toBe("First line.\n");
    expect(native.writeAttachment).not.toHaveBeenCalled();
  });

  it("with plain text goes to Milkdown's clipboard plugin, which pastes the text", { timeout: 60_000 }, async () => {
    const pasteImages = vi.fn<(files: File[]) => void>();
    const root = await open("First line.\n", undefined, { pasteImages });

    pasteImage(root, "Pasted text.");

    expect(pasteImages).not.toHaveBeenCalled();
    expect(editor!.getMarkdown()).toContain("Pasted text.");
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
    native.convertFileSrc.mockResolvedValue("downpad-file://pic");
    native.openDialog.mockResolvedValue("/docs/pic.png");
    block.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(image.getAttribute("src")).toBe("downpad-file://pic"));
    image.dispatchEvent(new Event("load"));
    expect(block.classList).not.toContain("md-image-missing");
    // A click on the found image leaves it alone.
    block.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(native.openDialog).toHaveBeenCalledTimes(1);
  });
});

describe("a missing image located at the path it has", () => {
  // The document is /docs/a.md, and the dialog returns absolute paths.
  it.each([
    ["on its own line", ".milkdown-image-block", "/docs/block.png", "/docs/block.png"],
    ["in a line of text", ".milkdown-image-inline", "/docs/inline.png", "/docs/inline.png"],
    ["on its own line, by a relative path", ".milkdown-image-block", "img/block.png", "/docs/img/block.png"],
    ["in a line of text, by a relative path", ".milkdown-image-inline", "./img/inline.png", "/docs/img/inline.png"],
  ])("shows the file put back there %s, and leaves the document as it was", { timeout: 60_000 }, async (_where, selector, src, picked) => {
    const markdown = selector === ".milkdown-image-block" ? `![Block](${src})\n\nText.\n` : `Inline ![Inline](${src}) here.\n`;
    native.convertFileSrc.mockResolvedValue(null);
    const onChange = vi.fn();
    const root = await open(markdown, onChange);
    // jsdom loads no images, so tell each view its empty source failed.
    for (const image of root.querySelectorAll("img")) image.dispatchEvent(new Event("error"));
    const host = root.querySelector<HTMLElement>(selector)!;
    const image = host.querySelector("img")!;
    expect(host.classList).toContain("md-image-missing");
    const view = viewOf(editor!);
    const depth = undoDepth(view.state);

    // The file is put back, and the user picks it at the path the Markdown has.
    native.convertFileSrc.mockResolvedValue("downpad-file://found");
    native.openDialog.mockResolvedValue(picked);
    host.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    await vi.waitFor(() => expect(image.getAttribute("src")).toBe("downpad-file://found"));
    image.dispatchEvent(new Event("load"));
    expect(host.classList).not.toContain("md-image-missing");
    // Past the 200 ms change report.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(editor!.getMarkdown()).toBe(markdown);
    expect(undoDepth(view.state)).toBe(depth);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("a missing image", () => {
  /** Open `markdown` with no image found, and fail the block's first load. */
  async function openMissing(markdown: string): Promise<HTMLElement> {
    native.convertFileSrc.mockResolvedValue(null);
    const root = await open(markdown);
    // jsdom loads no images, so tell the view the empty source failed.
    root.querySelector(".milkdown-image-block img")!.dispatchEvent(new Event("error"));
    return root;
  }

  it("shows the path its Markdown has now", { timeout: 60_000 }, async () => {
    const root = await openMissing("![Missing](gone.png)\n");
    const block = root.querySelector<HTMLElement>(".milkdown-image-block")!;
    expect(block.dataset.mdPath).toBe("gone.png");

    // The Markdown pane changes the path to another one Downpad cannot load.
    editor!.setMarkdown("![Missing](lost.png)\n");

    await vi.waitFor(() => expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/lost.png"));
    expect(block.classList).toContain("md-image-missing");
    expect(block.dataset.mdPath).toBe("lost.png");
  });

  it("shows the input for a path once its path is cleared", { timeout: 60_000 }, async () => {
    const root = await openMissing("![Missing](gone.png)\n");

    editor!.setMarkdown("![Missing]()\n");

    const block = root.querySelector(".milkdown-image-block")!;
    expect(block.classList).not.toContain("md-image-missing");
    await vi.waitFor(() => expect(block.querySelector("img")).toBeNull());
  });

  it("can be located after Crepe draws its image anew", { timeout: 60_000 }, async () => {
    const root = await openMissing("![Missing](gone.png)\n");
    const block = root.querySelector(".milkdown-image-block")!;
    // A path typed again after the old one was cleared gets a new <img>.
    const old = block.querySelector("img");
    editor!.setMarkdown("![Missing]()\n");
    editor!.setMarkdown("![Missing](lost.png)\n");
    const image = await vi.waitFor(() => {
      const shown = block.querySelector("img");
      expect(shown).not.toBe(old);
      expect(shown?.getAttribute("src")).toBe("data:,");
      return shown!;
    });
    image.dispatchEvent(new Event("error"));
    expect(block.classList).toContain("md-image-missing");

    native.convertFileSrc.mockResolvedValue("downpad-file://pic");
    native.openDialog.mockResolvedValue("/docs/pic.png");
    block.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(image.getAttribute("src")).toBe("downpad-file://pic"));
    expect(editor!.getMarkdown()).toBe("![Missing](/docs/pic.png)\n");
    image.dispatchEvent(new Event("load"));
    expect(block.classList).not.toContain("md-image-missing");
  });
});

describe("a missing inline image", () => {
  it("shows its path in a chip, which a click locates", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockImplementation(async (path) => (path === "/docs/pic.png" ? "downpad-file://pic" : null));
    const root = await open("![Lost](lost.png)\n\nInline ![inline](pic.png) and ![gone](gone.png).\n");
    // jsdom loads no images, so tell each view how its image fared.
    for (const image of root.querySelectorAll("img")) {
      image.dispatchEvent(new Event(image.getAttribute("src") === "data:," ? "error" : "load"));
    }
    const block = root.querySelector<HTMLElement>(".milkdown-image-block")!;
    const [working, chip] = root.querySelectorAll<HTMLElement>(".milkdown-image-inline");
    expect(chip.classList).toContain("md-image-missing");
    expect(chip.dataset.mdPath).toBe("gone.png");
    expect(chip.title).toBe("Missing image. Click to locate it.");
    expect(working.classList).not.toContain("md-image-missing");
    // The block's placeholder shows those words, so it has no hover text.
    expect(block.classList).toContain("md-image-missing");
    expect(block.dataset.mdPath).toBe("lost.png");
    expect(block.hasAttribute("title")).toBe(false);

    native.openDialog.mockResolvedValue("/docs/pic.png");
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const image = chip.querySelector("img")!;
    await vi.waitFor(() => expect(image.getAttribute("src")).toBe("downpad-file://pic"));
    expect(editor!.getMarkdown()).toBe("![Lost](lost.png)\n\nInline ![inline](pic.png) and ![gone](/docs/pic.png).\n");
    image.dispatchEvent(new Event("load"));
    expect(chip.classList).not.toContain("md-image-missing");
    expect(chip.hasAttribute("title")).toBe(false);
    expect(native.openDialog).toHaveBeenCalledTimes(1);
  });

  it("is located by a plain click only", { timeout: 60_000 }, async () => {
    native.convertFileSrc.mockResolvedValue(null);
    const root = await open("See [the ![gone](gone.png) chart](https://example.com).\n");
    root.querySelector("img")!.dispatchEvent(new Event("error"));
    const chip = root.querySelector(".milkdown-image-inline")!;
    expect(chip.classList).toContain("md-image-missing");

    // Ctrl or Cmd+click follows the link and Shift+click extends the selection,
    // so neither locates the file. The second click of a double-click opens no
    // second dialog.
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, [modifier]: true }));
    }
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(native.openDialog).not.toHaveBeenCalled();

    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(native.openDialog).toHaveBeenCalledTimes(1);
  });
});
