import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";

const native = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
}));
vi.mock("../../ipc/env", () => ({ isElectron: native.isElectron }));
vi.mock("../../ipc/bridge", () => ({ convertFileSrc: native.convertFileSrc }));

import { ANSWER_WAIT_MS, forgetImageAnswers, imageBlockFeatureConfig } from "./imageView";

/** One document editor's image feature config, for a document saved at `filePath`. */
function imageConfig(filePath: string | null | (() => string | null)) {
  return imageBlockFeatureConfig({ current: null }, {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: typeof filePath === "function" ? filePath : () => filePath,
    requestSave: async () => false,
  });
}

/** Crepe's image source mapping for a document saved at `filePath`. */
function proxyDomURL(filePath: string | null | (() => string | null)) {
  return imageConfig(filePath).proxyDomURL;
}

beforeEach(() => {
  native.isElectron.mockReturnValue(true);
  native.convertFileSrc.mockReset();
  forgetImageAnswers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("proxyDomURL", () => {
  it("loads a local image through its authorized URL", async () => {
    native.convertFileSrc.mockResolvedValueOnce("downpad-file://local/image?token=t");
    expect(await proxyDomURL("/docs/a.md")("pic.png")).toBe("downpad-file://local/image?token=t");
    expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/pic.png");
  });

  it.each([
    ["the file is missing", "/docs/a.md", () => native.convertFileSrc.mockResolvedValueOnce(null)],
    ["the path is not an image", "/docs/a.md", () => native.convertFileSrc.mockRejectedValueOnce(new Error("Only local images can be loaded."))],
    ["the document is not saved yet", null, () => {}],
  ])("shows a local image as missing when %s", async (_case, filePath, arrange) => {
    arrange();
    // A relative path here would be requested next to Downpad's own page.
    expect(await proxyDomURL(filePath)("missing.png")).toBe("data:,");
  });

  it("passes remote, data and empty sources through, and every source outside Electron", async () => {
    const proxy = proxyDomURL("/docs/a.md");
    expect(await proxy("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(await proxy("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
    // An empty source shows Crepe's upload input, which a placeholder would hide.
    expect(await proxy("")).toBe("");
    native.isElectron.mockReturnValue(false);
    expect(await proxy("pic.png")).toBe("pic.png");
    expect(native.convertFileSrc).not.toHaveBeenCalled();
  });

  it.each(["//h/s/a.png", "\\\\h\\s\\a.png", "%2F%2Fh/s/a.png", "%5C%5Ch%5Cs%5Ca.png", "/\\h/s/a.png", " //h/s/a.png", "file://h/s/a.png", "file:////h/s/a.png"])(
    "shows the network image %j as missing at once, without asking the main process",
    (src) => {
      // Chromium would fetch the raw src from a server, so it never reaches an <img>.
      expect(proxyDomURL("\\\\server\\share\\a.md")(src)).toBe("data:,");
      expect(native.convertFileSrc).not.toHaveBeenCalled();
    },
  );

  it("asks about an image relative to a document on a network share", async () => {
    native.convertFileSrc.mockResolvedValueOnce("downpad-file://local/image?token=t");
    expect(await proxyDomURL("\\\\server\\share\\a.md")("pic.png")).toBe("downpad-file://local/image?token=t");
    expect(native.convertFileSrc).toHaveBeenCalledWith("\\\\server\\share/pic.png");
    expect(proxyDomURL("/docs/a.md")("file:///docs/pic.png")).toBe("file:///docs/pic.png");
  });

  it.each([
    ["an image", "downpad-file://local/image?token=t", "downpad-file://local/image?token=t"],
    ["a missing image", null, "data:,"],
  ])("answers at once for %s it has looked up", async (_case, answer, shown) => {
    native.convertFileSrc.mockResolvedValueOnce(answer);
    const proxy = proxyDomURL("/docs/a.md");

    // A second view asking before the answer arrives waits for the same one.
    const [first, second] = [proxy("pic.png"), proxy("pic.png")];
    expect([await first, await second]).toEqual([shown, shown]);

    // Crepe shows a string answer from the view's first render.
    expect(proxy("pic.png")).toBe(shown);
    expect(native.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("looks a relative image up again once the document is saved elsewhere", async () => {
    native.convertFileSrc.mockImplementation(async (path) => `downpad-file://${path}`);
    let filePath = "/docs/a.md";
    const proxy = proxyDomURL(() => filePath);
    await proxy("pic.png");

    filePath = "/other/a.md";

    expect(await proxy("pic.png")).toBe("downpad-file:///other/pic.png");
  });

  it("gives a document editor built again the answers at once", async () => {
    native.convertFileSrc.mockResolvedValueOnce("downpad-file://local/image?token=t");
    await proxyDomURL("/docs/a.md")("pic.png");

    // A layout switch, a settings change or Print builds another editor.
    expect(proxyDomURL("/docs/a.md")("pic.png")).toBe("downpad-file://local/image?token=t");
    expect(native.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("asks about a missing image again once the document is opened again", async () => {
    native.convertFileSrc.mockResolvedValueOnce(null);
    expect(await proxyDomURL("/docs/a.md")("pic.png")).toBe("data:,");

    forgetImageAnswers();
    native.convertFileSrc.mockResolvedValueOnce("downpad-file://local/image?token=t");

    expect(await proxyDomURL("/docs/a.md")("pic.png")).toBe("downpad-file://local/image?token=t");
  });
});

describe("preload", () => {
  it("waits for a lookup at most ANSWER_WAIT_MS from when it was first sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    native.convertFileSrc.mockReturnValue(new Promise(() => {}));
    const first = vi.fn();
    void imageConfig("/docs/a.md").preload(["pic.png"]).then(first);

    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
    expect(first).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toHaveBeenCalled();

    // An editor built later does not wait for that lookup again or send another.
    const later = vi.fn();
    void imageConfig("/docs/a.md").preload(["pic.png"]).then(later);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalled();
    expect(native.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("settles as soon as every image has an answer", async () => {
    // No timer runs, so a wait for one would never end.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    native.convertFileSrc.mockImplementation(async (path) => (path === "/docs/pic.png" ? "downpad-file://pic" : null));

    await imageConfig("/docs/a.md").preload(["pic.png", "gone.png", "https://example.com/a.png", ""]);

    expect(proxyDomURL("/docs/a.md")("pic.png")).toBe("downpad-file://pic");
    expect(proxyDomURL("/docs/a.md")("gone.png")).toBe("data:,");
  });
});
