import { describe, it, expect, vi } from "vitest";
import { decideImageStorage, bytesToBase64, storeImage } from "./imageStore";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { Settings } from "../state/types";

describe("decideImageStorage", () => {
  it("embeds when base64 is on and the image is within the limit", () => {
    expect(
      decideImageStorage({
        byteSize: 100 * 1024,
        embedImagesAsBase64: true,
        maxEmbedSizeKB: 2048,
        hasFilePath: false,
      }),
    ).toBe("embed");
  });

  it("uses attachments for over-limit images when the doc is saved", () => {
    expect(
      decideImageStorage({
        byteSize: 5 * 1024 * 1024,
        embedImagesAsBase64: true,
        maxEmbedSizeKB: 2048,
        hasFilePath: true,
      }),
    ).toBe("attachment");
  });

  it("needs a save when the attachment path is required but unsaved", () => {
    expect(
      decideImageStorage({
        byteSize: 5 * 1024 * 1024,
        embedImagesAsBase64: true,
        maxEmbedSizeKB: 2048,
        hasFilePath: false,
      }),
    ).toBe("need-save");
  });

  it("uses attachments when base64 embedding is disabled (saved doc)", () => {
    expect(
      decideImageStorage({
        byteSize: 10,
        embedImagesAsBase64: false,
        maxEmbedSizeKB: 2048,
        hasFilePath: true,
      }),
    ).toBe("attachment");
  });

  it("treats an image exactly at the limit as embeddable", () => {
    expect(
      decideImageStorage({
        byteSize: 2048 * 1024,
        embedImagesAsBase64: true,
        maxEmbedSizeKB: 2048,
        hasFilePath: false,
      }),
    ).toBe("embed");
  });
});

describe("bytesToBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 65, 66]);
    expect(atob(bytesToBase64(bytes))).toBe(String.fromCharCode(...bytes));
  });

  it("handles buffers larger than one chunk without throwing", () => {
    const big = new Uint8Array(0x8000 * 2 + 5).fill(7);
    expect(() => bytesToBase64(big)).not.toThrow();
    expect(bytesToBase64(big).length).toBeGreaterThan(0);
  });
});

describe("storeImage", () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

  it("returns a data URI for the embed path (no save needed)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await storeImage({ bytes, mime: "image/png", settings: settings(), filePath: null });
    expect(result.decision).toBe("embed");
    expect(result.src).toBe(`data:image/png;base64,${bytesToBase64(bytes)}`);
  });

  it("writes an attachment and returns the relative link for over-limit images", async () => {
    // maxEmbedSizeKB: 0 forces the attachment path with a tiny buffer.
    const bytes = new Uint8Array([1, 2, 3]);
    const write = vi.fn().mockResolvedValue("attachments/img-x.png");
    const result = await storeImage(
      { bytes, mime: "image/png", settings: settings({ maxEmbedSizeKB: 0 }), filePath: "C:/n/note.md", isoTimestamp: "2026-05-31T15:42:11.000Z" },
      write,
    );
    expect(result.decision).toBe("attachment");
    expect(result.src).toBe("attachments/img-x.png");
    expect(write).toHaveBeenCalledWith("C:/n/note.md", "attachments", "img-2026-05-31T15-42-11Z.png", bytes);
  });

  it("returns need-save (no src) for an over-limit image in an untitled buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const write = vi.fn();
    const result = await storeImage(
      { bytes, mime: "image/png", settings: settings({ maxEmbedSizeKB: 0 }), filePath: null },
      write,
    );
    expect(result.decision).toBe("need-save");
    expect(result.src).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });
});
