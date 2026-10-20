import { beforeEach, describe, it, expect, vi } from "vitest";
import { decideImageStorage, bytesToBase64, resolveImageSrc, storeImage, type ImageStoreContext } from "./imageStore";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { Settings } from "../state/types";

const disk = vi.hoisted(() => ({
  /** Gives the image's link from the document, as the main process does. */
  writeAttachment: vi.fn<(docPath: string, folder: string, name: string, bytes: Uint8Array) => Promise<string>>(),
}));

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  writeAttachment: disk.writeAttachment,
}));

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

describe("resolveImageSrc", () => {
  /** A promise and the function that resolves it. */
  function held<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  /** Let pending promise callbacks run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A document saved at `doc.filePath` that stores images as files. While a
   *  test holds `doc.saveAs`, a Save As of it is under way, so
   *  `untilPathSettled` waits for it. */
  function documentAt(filePath: string) {
    const doc = { filePath, saveAs: null as Promise<void> | null };
    const ctx: ImageStoreContext = {
      getSettings: () => ({ ...DEFAULT_SETTINGS, embedImagesAsBase64: false }),
      getFilePath: () => doc.filePath,
      requestSave: async () => false,
      untilPathSettled: async () => {
        while (doc.saveAs) await doc.saveAs;
      },
    };
    return { doc, ctx };
  }

  const bytes = new Uint8Array([1, 2, 3]);

  beforeEach(() => {
    disk.writeAttachment.mockReset();
    disk.writeAttachment.mockImplementation(async (_docPath, folder, name) => `${folder}/${name}`);
  });

  it("writes an image beside the document where a Save As under way puts it", async () => {
    const { doc, ctx } = documentAt("/docs/notes.md");
    const saved = held();
    doc.saveAs = saved.promise;
    const src = resolveImageSrc(bytes, "image/png", ctx);
    await settle();
    expect(disk.writeAttachment).not.toHaveBeenCalled();

    doc.filePath = "/moved/notes.md";
    doc.saveAs = null;
    saved.resolve();

    expect(await src).toMatch(/^attachments\/img-[^/]+\.png$/);
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
    expect(disk.writeAttachment).toHaveBeenCalledWith("/moved/notes.md", "attachments", expect.stringMatching(/^img-/), bytes);
  });

  it("writes an image again beside the document when a Save As puts it in another folder while the image is written", async () => {
    const { doc, ctx } = documentAt("/docs/notes.md");
    const write = held<string>();
    disk.writeAttachment.mockReturnValueOnce(write.promise);
    const src = resolveImageSrc(bytes, "image/png", ctx);
    await settle();
    expect(disk.writeAttachment).toHaveBeenCalledWith("/docs/notes.md", "attachments", expect.any(String), bytes);
    const name = disk.writeAttachment.mock.calls[0]![2];
    // The user starts Save As while the image is written, and the write ends
    // while its dialog is still open.
    const saved = held();
    doc.saveAs = saved.promise;
    write.resolve(`attachments/${name}`);
    await settle();
    expect(disk.writeAttachment).toHaveBeenCalledOnce();

    doc.filePath = "/moved/notes.md";
    doc.saveAs = null;
    saved.resolve();

    // The copy beside the old place stays, and the link leads to the new one.
    // Each write names its file from the clock, so the names can differ.
    const linked = await src;
    expect(disk.writeAttachment).toHaveBeenCalledTimes(2);
    expect(disk.writeAttachment).toHaveBeenLastCalledWith("/moved/notes.md", "attachments", expect.stringMatching(/^img-/), bytes);
    expect(linked).toBe(`attachments/${disk.writeAttachment.mock.calls[1]![2]}`);
  });

  it("embeds an image at once while a Save As of the document is under way", async () => {
    const { doc, ctx } = documentAt("/docs/notes.md");
    doc.saveAs = new Promise(() => {});
    const embedding = { ...ctx, getSettings: () => DEFAULT_SETTINGS };
    let src: string | null | undefined;
    void resolveImageSrc(bytes, "image/png", embedding).then((value) => (src = value));
    await settle();

    // A data URI holds the image wherever the document is saved.
    expect(src).toBe("data:image/png;base64,AQID");
    expect(disk.writeAttachment).not.toHaveBeenCalled();
  });

  it("looks an image up again beside the document when a Save As puts it in another folder while it is looked up", async () => {
    const { doc, ctx } = documentAt("/docs/notes.md");
    const firstAnswer = held();
    const lookUp = vi.fn(async (_src: string, _filePath: string) => {});
    lookUp.mockReturnValueOnce(firstAnswer.promise);
    const src = resolveImageSrc(bytes, "image/png", ctx, lookUp);
    await settle();
    expect(lookUp).toHaveBeenCalledWith(expect.stringMatching(/^attachments\/img-/), "/docs/notes.md");
    // A Save As ends before the answer comes.
    doc.filePath = "/moved/notes.md";
    firstAnswer.resolve();

    const linked = await src;
    expect(disk.writeAttachment).toHaveBeenCalledTimes(2);
    expect(disk.writeAttachment).toHaveBeenLastCalledWith("/moved/notes.md", "attachments", expect.stringMatching(/^img-/), bytes);
    expect(lookUp).toHaveBeenCalledTimes(2);
    expect(lookUp).toHaveBeenLastCalledWith(linked, "/moved/notes.md");
  });

  it("looks up no embedded image", async () => {
    const { ctx } = documentAt("/docs/notes.md");
    const lookUp = vi.fn(async () => {});

    expect(await resolveImageSrc(bytes, "image/png", { ...ctx, getSettings: () => DEFAULT_SETTINGS }, lookUp)).toMatch(/^data:/);
    expect(lookUp).not.toHaveBeenCalled();
  });

  it("keeps an image written beside a document saved under another name in the same folder", async () => {
    const { doc, ctx } = documentAt("/docs/notes.md");
    const write = held<string>();
    disk.writeAttachment.mockReturnValueOnce(write.promise);
    const src = resolveImageSrc(bytes, "image/png", ctx);
    await settle();
    doc.filePath = "/docs/renamed.md";
    write.resolve("attachments/img.png");

    expect(await src).toBe("attachments/img.png");
    expect(disk.writeAttachment).toHaveBeenCalledOnce();
  });
});
