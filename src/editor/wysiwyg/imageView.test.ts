import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";

const native = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  convertFileSrc: vi.fn<(path: string) => Promise<string | null>>(),
}));
vi.mock("../../ipc/env", () => ({ isElectron: native.isElectron }));
vi.mock("../../ipc/bridge", () => ({ convertFileSrc: native.convertFileSrc }));

import { imageBlockFeatureConfig } from "./imageView";

/** Crepe's image source mapping for a document saved at `filePath`. */
function proxyDomURL(filePath: string | null | (() => string | null)) {
  return imageBlockFeatureConfig({ current: null }, {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: typeof filePath === "function" ? filePath : () => filePath,
    requestSave: async () => false,
  }).proxyDomURL;
}

beforeEach(() => {
  native.isElectron.mockReturnValue(true);
  native.convertFileSrc.mockReset();
});

describe("proxyDomURL", () => {
  it("loads a local image through its authorized URL", async () => {
    native.convertFileSrc.mockResolvedValueOnce("md-easy-file://local/image?token=t");
    expect(await proxyDomURL("/docs/a.md")("pic.png")).toBe("md-easy-file://local/image?token=t");
    expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/pic.png");
  });

  it.each([
    ["the file is missing", "/docs/a.md", () => native.convertFileSrc.mockResolvedValueOnce(null)],
    ["the path is not an image", "/docs/a.md", () => native.convertFileSrc.mockRejectedValueOnce(new Error("Only local images can be loaded."))],
    ["the document is not saved yet", null, () => {}],
  ])("shows a local image as missing when %s", async (_case, filePath, arrange) => {
    arrange();
    // A relative path here would be requested next to md-easy's own page.
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

  it.each([
    ["an image", "md-easy-file://local/image?token=t", "md-easy-file://local/image?token=t"],
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
    native.convertFileSrc.mockImplementation(async (path) => `md-easy-file://${path}`);
    let filePath = "/docs/a.md";
    const proxy = proxyDomURL(() => filePath);
    await proxy("pic.png");

    filePath = "/other/a.md";

    expect(await proxy("pic.png")).toBe("md-easy-file:///other/pic.png");
  });
});
