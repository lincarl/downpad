import { afterEach, expect, it, vi } from "vitest";
import filesystem, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { ipcBytes, readImage, writeAttachment } from "./io";

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

it("holds up no other folder's attachments when a write never returns, and keeps one folder's writes in order", async () => {
  const directory = await fixtureDirectory();
  const gone = join(directory, "gone-drive");
  const local = join(directory, "local");
  await mkdir(gone);
  await mkdir(local);
  // A drive that went away never answers the write that stages the file.
  const originalOpen = filesystem.open;
  const never = new Promise<never>(() => {});
  vi.spyOn(filesystem, "open").mockImplementation((path, ...rest) => (String(path).startsWith(gone) ? never : originalOpen(path, ...rest)));
  syncBuiltinESMExports();
  const bytes = Uint8Array.of(1, 2, 3);
  const settled: string[] = [];
  void writeAttachment(join(gone, "note.md"), "attachments", "a.png", bytes).finally(() => settled.push("gone"));

  expect(await writeAttachment(join(local, "note.md"), "attachments", "a.png", bytes)).toBe("attachments/a.png");
  // The folder's own writes still take turns, so the names they claim keep their order.
  const [first, second] = await Promise.all([
    writeAttachment(join(local, "note.md"), "attachments", "a.png", bytes),
    writeAttachment(join(local, "other.md"), "attachments", "a.png", bytes),
  ]);
  expect([first, second]).toEqual(["attachments/a-1.png", "attachments/a-2.png"]);
  expect(settled).toEqual([]);
});

it("rejects a folder outside the document's folder without queueing anything", async () => {
  const directory = await fixtureDirectory();
  await expect(writeAttachment(join(directory, "note.md"), "../elsewhere", "a.png", Uint8Array.of(1))).rejects.toThrow("must stay inside the document folder");
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

it.skipIf(process.platform === "win32")("gives writes through two spellings of one folder their own names when hard links are unavailable", async () => {
  const directory = await fixtureDirectory();
  // Another spelling of the documents' folder, as a mapped drive and its network path are.
  const alias = `${directory}-alias`;
  await symlink(directory, alias);
  temporaryDirectories.push(alias);
  const attachments = join(directory, "attachments");
  await mkdir(attachments);
  await writeFile(join(attachments, "image.png"), Uint8Array.of(9));
  vi.spyOn(filesystem, "link").mockRejectedValue(Object.assign(new Error("Hard links are unsupported."), { code: "ENOTSUP" }));
  const originalRename = filesystem.rename;
  const started = deferred();
  const release = deferred();
  const renaming = vi.spyOn(filesystem, "rename").mockImplementationOnce(async (existing, destination) => {
    started.resolve();
    await release.promise;
    return originalRename(existing, destination);
  });
  syncBuiltinESMExports();
  const older = writeAttachment(join(directory, "note.md"), "attachments", "image.png", Uint8Array.of(1, 2, 3));
  await started.promise;
  const newer = writeAttachment(join(alias, "other.md"), "attachments", "image.png", Uint8Array.of(4, 5, 6));
  try {
    // The newer write waits for the older one, though its path is spelled otherwise.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renaming).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await Promise.allSettled([older, newer]);
  }
  expect(await Promise.all([older, newer])).toEqual(["attachments/image-1.png", "attachments/image-2.png"]);
  expect(await readFile(join(attachments, "image-1.png"))).toEqual(Buffer.from([1, 2, 3]));
  expect(await readFile(join(attachments, "image-2.png"))).toEqual(Buffer.from([4, 5, 6]));
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

it("reads an image as one Uint8Array, which IPC copies as binary", async () => {
  const directory = await fixtureDirectory();
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7) % 256);
  await writeFile(join(directory, "picture.png"), bytes);
  const image = await readImage(join(directory, "picture.png"));
  expect(image.bytes).toBeInstanceOf(Uint8Array);
  expect(image.bytes).toEqual(bytes);
  expect(image.mime).toBe("image/png");
  // IPC sends the whole backing buffer, which here is only the file.
  expect(image.bytes.buffer.byteLength).toBe(bytes.byteLength);
});

it("passes on a buffer that holds only the file and copies one from the shared pool", () => {
  const own = Buffer.allocUnsafeSlow(3).fill(7);
  expect(ipcBytes(own).buffer).toBe(own.buffer);
  const pooled = Buffer.from("small");
  expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength);
  const bytes = ipcBytes(pooled);
  expect(bytes.buffer.byteLength).toBe(5);
  expect(new TextDecoder().decode(bytes)).toBe("small");
});
