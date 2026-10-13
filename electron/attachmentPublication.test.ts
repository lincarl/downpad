import { afterEach, expect, it, vi } from "vitest";
import filesystem, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { writeAttachment } from "./io";

const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const root = resolve("dev-temp", "electron-attachments");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("keeps the final attachment invisible to readers until all bytes have been written", async () => {
  const directory = await fixtureDirectory();
  const attachments = join(directory, "attachments");
  const bytes = Uint8Array.from({ length: 8192 }, (_, index) => index % 256);
  const started = deferred();
  const release = deferred();
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    const originalWrite = file.writeFile.bind(file);
    vi.spyOn(file, "writeFile").mockImplementationOnce(async (data) => {
      if (!(data instanceof Uint8Array)) throw new Error("The fixture expects attachment bytes.");
      await originalWrite(data.subarray(0, data.length / 2));
      started.resolve();
      await release.promise;
      await originalWrite(data.subarray(data.length / 2));
    });
    return file;
  });
  syncBuiltinESMExports();
  const saving = writeAttachment(join(directory, "note.md"), "attachments", "image.png", bytes);
  await started.promise;
  try {
    const temporary = (await readdir(attachments))[0]!;
    expect(temporary.startsWith(".")).toBe(true);
    expect(await readFile(join(attachments, temporary))).toEqual(Buffer.from(bytes.subarray(0, bytes.length / 2)));
    await expect(stat(join(attachments, "image.png"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    await saving;
  }
  expect(await saving).toBe("attachments/image.png");
  expect(await readFile(join(attachments, "image.png"))).toEqual(Buffer.from(bytes));
  expect(await readdir(attachments)).toEqual(["image.png"]);
});

it("keeps a colliding file created immediately before exclusive publication", async () => {
  const directory = await fixtureDirectory();
  const originalLink = filesystem.link;
  vi.spyOn(filesystem, "link").mockImplementationOnce(async (existing, destination) => {
    // Another writer claims the name after our complete staging write.
    await writeFile(destination, Uint8Array.of(9, 8, 7));
    return originalLink(existing, destination);
  });
  syncBuiltinESMExports();
  const relative = await writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1, 2, 3));
  expect(relative).toBe("attachments/image-1.png");
  expect(await readFile(join(directory, "attachments", "image.png"))).toEqual(Buffer.from([9, 8, 7]));
  expect(await readFile(join(directory, relative))).toEqual(Buffer.from([1, 2, 3]));
  expect((await readdir(join(directory, "attachments"))).sort()).toEqual(["image-1.png", "image.png"]);
});

it("serializes complete-file rename fallback when hard links are unavailable", async () => {
  const directory = await fixtureDirectory();
  const attachments = join(directory, "attachments");
  await mkdir(attachments);
  await writeFile(join(attachments, "image.png"), Uint8Array.of(9));
  const unsupported = Object.assign(new Error("Hard links are unsupported."), { code: "ENOTSUP" });
  vi.spyOn(filesystem, "link").mockRejectedValue(unsupported);
  const originalRename = filesystem.rename;
  const started = deferred();
  const release = deferred();
  vi.spyOn(filesystem, "rename").mockImplementationOnce(async (existing, destination) => {
    expect(await readFile(existing)).toEqual(Buffer.from([1, 2, 3]));
    started.resolve();
    await release.promise;
    return originalRename(existing, destination);
  });
  const creatingDirectory = vi.spyOn(filesystem, "mkdir");
  syncBuiltinESMExports();
  const older = writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1, 2, 3));
  await started.promise;
  const newer = writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(4, 5, 6));
  try {
    expect(creatingDirectory).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await Promise.allSettled([older, newer]);
  }
  expect(await Promise.all([older, newer])).toEqual(["attachments/image-1.png", "attachments/image-2.png"]);
  expect(await readFile(join(attachments, "image.png"))).toEqual(Buffer.from([9]));
  expect(await readFile(join(attachments, "image-1.png"))).toEqual(Buffer.from([1, 2, 3]));
  expect(await readFile(join(attachments, "image-2.png"))).toEqual(Buffer.from([4, 5, 6]));
  expect((await readdir(attachments)).sort()).toEqual(["image-1.png", "image-2.png", "image.png"]);
});

it("removes incomplete staging files after write failure and continues queued attachments", async () => {
  const directory = await fixtureDirectory();
  const originalOpen = filesystem.open;
  const failed = new Error("The attachment write failed.");
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    const originalWrite = file.writeFile.bind(file);
    vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
      await originalWrite(Uint8Array.of(1));
      throw failed;
    });
    return file;
  });
  syncBuiltinESMExports();
  const broken = writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1, 2, 3));
  const following = writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(4, 5, 6));
  await expect(broken).rejects.toBe(failed);
  expect(await following).toBe("attachments/image.png");
  expect(await readFile(join(directory, "attachments", "image.png"))).toEqual(Buffer.from([4, 5, 6]));
  expect(await readdir(join(directory, "attachments"))).toEqual(["image.png"]);
});

it("cleans staging after fallback publication failure and allows the next save", async () => {
  const directory = await fixtureDirectory();
  const unsupported = Object.assign(new Error("Hard links are unsupported."), { code: "ENOTSUP" });
  const failed = Object.assign(new Error("Rename failed."), { code: "EIO" });
  vi.spyOn(filesystem, "link").mockRejectedValue(unsupported);
  vi.spyOn(filesystem, "rename").mockRejectedValueOnce(failed);
  syncBuiltinESMExports();
  await expect(writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1))).rejects.toBe(failed);
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
  expect(await writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(2))).toBe("attachments/image.png");
  expect(await readFile(join(directory, "attachments", "image.png"))).toEqual(Buffer.from([2]));
  expect(await readdir(join(directory, "attachments"))).toEqual(["image.png"]);
});

it("propagates hard-link permission failures without falling back to a replacement rename", async () => {
  const directory = await fixtureDirectory();
  const denied = Object.assign(new Error("Permission denied."), { code: "EACCES" });
  vi.spyOn(filesystem, "link").mockRejectedValueOnce(denied);
  const renaming = vi.spyOn(filesystem, "rename");
  syncBuiltinESMExports();
  await expect(writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1))).rejects.toBe(denied);
  expect(renaming).not.toHaveBeenCalled();
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});
