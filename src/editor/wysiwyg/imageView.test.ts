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
function proxyDomURL(filePath: string | null) {
  return imageBlockFeatureConfig({ current: null }, {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => filePath,
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
    await expect(proxyDomURL("/docs/a.md")("pic.png")).resolves.toBe("md-easy-file://local/image?token=t");
    expect(native.convertFileSrc).toHaveBeenCalledWith("/docs/pic.png");
  });

  it.each([
    ["the file is missing", "/docs/a.md", () => native.convertFileSrc.mockResolvedValueOnce(null)],
    ["the path is not an image", "/docs/a.md", () => native.convertFileSrc.mockRejectedValueOnce(new Error("Only local images can be loaded."))],
    ["the document is not saved yet", null, () => {}],
  ])("shows a local image as missing when %s", async (_case, filePath, arrange) => {
    arrange();
    // A relative path here would be requested next to md-easy's own page.
    await expect(proxyDomURL(filePath)("missing.png")).resolves.toBe("data:,");
  });

  it("passes remote, data and empty sources through, and every source outside Electron", async () => {
    const proxy = proxyDomURL("/docs/a.md");
    await expect(proxy("https://example.com/a.png")).resolves.toBe("https://example.com/a.png");
    await expect(proxy("data:image/png;base64,AA==")).resolves.toBe("data:image/png;base64,AA==");
    // An empty source shows Crepe's upload input, which a placeholder would hide.
    await expect(proxy("")).resolves.toBe("");
    native.isElectron.mockReturnValue(false);
    await expect(proxy("pic.png")).resolves.toBe("pic.png");
    expect(native.convertFileSrc).not.toHaveBeenCalled();
  });
});
