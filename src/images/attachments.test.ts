import { describe, it, expect, vi } from "vitest";
import { attachmentFileName, extForMime, sanitizeTimestamp } from "./attachments";

describe("extForMime", () => {
  it("maps known image MIME types", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/svg+xml")).toBe("svg");
    expect(extForMime("IMAGE/GIF")).toBe("gif");
  });

  it("falls back to the subtype for unknown image types", () => {
    expect(extForMime("image/heic")).toBe("heic");
  });

  it("falls back to bin for non-extension-safe types", () => {
    // octet-stream contains a hyphen, so it's not a safe bare extension.
    expect(extForMime("application/octet-stream")).toBe("bin");
    expect(extForMime("weird")).toBe("bin");
  });
});

describe("sanitizeTimestamp", () => {
  it("drops milliseconds and replaces colons (Windows-illegal)", () => {
    expect(sanitizeTimestamp("2026-05-31T15:42:11.000Z")).toBe("2026-05-31T15-42-11Z");
    expect(sanitizeTimestamp("2026-05-31T15:42:11Z")).toBe("2026-05-31T15-42-11Z");
  });
});

describe("attachmentFileName", () => {
  it("builds a path-safe img-<ts>.<ext> name", () => {
    expect(attachmentFileName("image/png", "2026-05-31T15:42:11.000Z")).toBe(
      "img-2026-05-31T15-42-11Z.png",
    );
    expect(attachmentFileName("image/jpeg", "2026-01-02T03:04:05.678Z")).toBe(
      "img-2026-01-02T03-04-05Z.jpg",
    );
  });

  it("names the image from the current UTC time by default, with no characters illegal in Windows filenames", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-31T15:42:11.250Z"));
      const name = attachmentFileName("image/png");
      expect(name).toBe("img-2026-05-31T15-42-11Z.png");
      expect(name).not.toMatch(/[<>:"/\\|?*]/);
    } finally {
      vi.useRealTimers();
    }
  });
});
