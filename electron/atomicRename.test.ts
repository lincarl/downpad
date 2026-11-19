import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import filesystem, { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { FILE_CHANGED_ON_DISK } from "../src/ipc/contracts";
import { fileStamp, readMarkdown, ReplaceDeclinedError, writeAtomic, writeMarkdown } from "./io";

const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ directory: string; destination: string }> {
  const root = resolve("dev-temp", "electron-atomic-rename");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-"));
  temporaryDirectories.push(directory);
  const destination = join(directory, "note.md");
  await writeFile(destination, "Original text\n");
  return { directory, destination };
}

function simulatePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
}

afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient Windows %s rename failure without rewriting the staged file", async (code) => {
  const { directory, destination } = await fixture();
  const originalRename = filesystem.rename;
  const sharing = Object.assign(new Error("The file has a transient sharing lock."), { code });
  const renaming = vi.spyOn(filesystem, "rename").mockImplementationOnce(async (source) => {
    expect(await readFile(source, "utf8")).toBe("Replacement text\n");
    expect(await readFile(destination, "utf8")).toBe("Original text\n");
    throw sharing;
  }).mockImplementation(originalRename);
  syncBuiltinESMExports();
  simulatePlatform("win32");

  await writeAtomic(destination, "Replacement text\n");
  expect(renaming).toHaveBeenCalledTimes(2);
  expect(renaming.mock.calls[0]).toEqual(renaming.mock.calls[1]);
  expect(await readFile(destination, "utf8")).toBe("Replacement text\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it("reports the time of the file it wrote, not of one another program put there right after", async () => {
  const { destination } = await fixture();
  const originalRename = filesystem.rename;
  vi.spyOn(filesystem, "rename").mockImplementationOnce(async (source, target) => {
    await originalRename(source, target);
    // Another program replaces the file before Downpad could read its time.
    await writeFile(target, "Theirs\n");
    await utimes(target, new Date(), new Date(Date.now() + 60_000));
  });
  syncBuiltinESMExports();

  const { modifiedMs } = await writeMarkdown(destination, "Mine\n", "lf");
  expect(modifiedMs).toBeLessThan(Math.floor((await stat(destination)).mtimeMs) - 30_000);
});

it("reads a file's text and time from one open file, so a replacement right after the read does not mix them", async () => {
  const { directory, destination } = await fixture();
  await utimes(destination, new Date(), new Date(Date.now() - 60_000));
  const original = Math.floor((await stat(destination)).mtimeMs);
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    const readText = handle.readFile.bind(handle);
    handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
      const bytes = await readText(...options);
      // Another program replaces the file right after the read.
      const replacement = join(directory, "replacement.md");
      await writeFile(replacement, "Theirs\n");
      await rename(replacement, destination);
      return bytes;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();

  const read = await readMarkdown(destination);
  expect(read).toMatchObject({ content: "Original text\n", modifiedMs: original });
  expect(await readFile(destination, "utf8")).toBe("Theirs\n");
});

it("checks again before a Windows rename retry, and leaves a file changed meanwhile", async () => {
  const { directory, destination } = await fixture();
  const originalRename = filesystem.rename;
  const sharing = Object.assign(new Error("The file has a transient sharing lock."), { code: "EBUSY" });
  vi.spyOn(filesystem, "rename").mockImplementationOnce(async () => {
    // Another program saves the file while the rename waits to retry.
    await writeFile(destination, "Theirs\n");
    throw sharing;
  }).mockImplementation(originalRename);
  syncBuiltinESMExports();
  simulatePlatform("win32");
  let checks = 0;
  const beforeReplace = async () => {
    checks += 1;
    return (await readFile(destination, "utf8")) === "Original text\n";
  };

  await expect(writeAtomic(destination, "Replacement text\n", { beforeReplace })).rejects.toBeInstanceOf(ReplaceDeclinedError);
  expect(checks).toBe(2);
  expect(await readFile(destination, "utf8")).toBe("Theirs\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it("refuses an automatic write when another program replaces the file while the check reads it", async () => {
  const { directory, destination } = await fixture();
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== destination) return handle;
    const readText = handle.readFile.bind(handle);
    handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
      const bytes = await readText(...options);
      // Another program replaces the file with its own text during the read.
      const replacement = join(directory, "replacement.md");
      await writeFile(replacement, "Theirs\n");
      await rename(replacement, destination);
      return bytes;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();

  await expect(writeMarkdown(destination, "Mine\n", "lf", "Original text\n")).rejects.toThrow(FILE_CHANGED_ON_DISK);
  expect(await readFile(destination, "utf8")).toBe("Theirs\n");
});

it("retries a Windows sharing lock that the check before the rename meets", async () => {
  const { destination } = await fixture();
  simulatePlatform("win32");
  let checks = 0;
  const beforeReplace = async () => {
    checks += 1;
    if (checks === 1) throw Object.assign(new Error("The file has a transient sharing lock."), { code: "EBUSY" });
    return true;
  };
  await writeAtomic(destination, "Replacement text\n", { beforeReplace });
  expect(checks).toBe(2);
  expect(await readFile(destination, "utf8")).toBe("Replacement text\n");
});

it("fails a read of a file that keeps changing while it is read", async () => {
  const { destination } = await fixture();
  const originalOpen = filesystem.open;
  let rewrites = 0;
  vi.spyOn(filesystem, "open").mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    const readText = handle.readFile.bind(handle);
    handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
      const bytes = await readText(...options);
      rewrites += 1;
      await writeFile(destination, `Rewrite ${rewrites}, which is longer each time\n`.repeat(rewrites));
      return bytes;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();
  await expect(readMarkdown(destination)).rejects.toThrow("The file kept changing while it was read.");
  expect(rewrites).toBe(3);
});

it("reads a file again that another program rewrites in place while it is read", async () => {
  const { destination } = await fixture();
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    const readText = handle.readFile.bind(handle);
    handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
      const bytes = await readText(...options);
      // Another program rewrites the same file in place right after the read.
      await writeFile(destination, "Rewritten in place\n");
      await utimes(destination, new Date(), new Date(Date.now() + 60_000));
      return bytes;
    }) as typeof handle.readFile;
    return handle;
  });
  syncBuiltinESMExports();

  const read = await readMarkdown(destination);
  expect(read).toMatchObject({ content: "Rewritten in place\n", modifiedMs: Math.floor((await stat(destination)).mtimeMs) });
});

it("writes a document only while the file holds the text it expects, and stamps a file with its time and size", async () => {
  const { destination } = await fixture();
  expect(await fileStamp(destination)).toEqual({ modifiedMs: Math.floor((await stat(destination)).mtimeMs), sizeBytes: 14 });

  const written = await writeMarkdown(destination, "Mine\n", "lf", "Original text\n");
  expect(written).toEqual({ modifiedMs: expect.any(Number), sizeBytes: 5 });
  expect(await readFile(destination, "utf8")).toBe("Mine\n");

  // Another program replaces the file and keeps its time.
  await writeFile(destination, "Theirs\n");
  await utimes(destination, new Date(), new Date(written.modifiedMs));
  await expect(writeMarkdown(destination, "Mine again\n", "lf", "Mine\n")).rejects.toThrow(FILE_CHANGED_ON_DISK);
  expect(await readFile(destination, "utf8")).toBe("Theirs\n");
});

it.each(["linux", "darwin"] as const)("fails immediately on %s and keeps the old file and removes staging", async (platform) => {
  const { directory, destination } = await fixture();
  const sharing = Object.assign(new Error("Permission denied."), { code: "EPERM" });
  const renaming = vi.spyOn(filesystem, "rename").mockRejectedValue(sharing);
  syncBuiltinESMExports();
  simulatePlatform(platform);

  await expect(writeAtomic(destination, "Replacement text\n")).rejects.toBe(sharing);
  expect(renaming).toHaveBeenCalledTimes(1);
  expect(await readFile(destination, "utf8")).toBe("Original text\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it.each(["EIO", "ENOENT"])("does not retry unrelated Windows %s failures", async (code) => {
  const { directory, destination } = await fixture();
  const failed = Object.assign(new Error("Rename failed."), { code });
  const renaming = vi.spyOn(filesystem, "rename").mockRejectedValue(failed);
  syncBuiltinESMExports();
  simulatePlatform("win32");

  await expect(writeAtomic(destination, "Replacement text\n")).rejects.toBe(failed);
  expect(renaming).toHaveBeenCalledTimes(1);
  expect(await readFile(destination, "utf8")).toBe("Original text\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it("stops retrying a persistent Windows sharing failure and cleans staging without changing the destination", async () => {
  const { directory, destination } = await fixture();
  const sharing = Object.assign(new Error("The file remains locked."), { code: "EBUSY" });
  const renaming = vi.spyOn(filesystem, "rename").mockRejectedValue(sharing);
  syncBuiltinESMExports();
  simulatePlatform("win32");

  await expect(writeAtomic(destination, "Replacement text\n")).rejects.toBe(sharing);
  expect(renaming).toHaveBeenCalledTimes(11);
  expect(await readFile(destination, "utf8")).toBe("Original text\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it("keeps Markdown saves ordered while an older Windows replacement waits for retry", async () => {
  const { directory, destination } = await fixture();
  const originalRename = filesystem.rename;
  const sharing = Object.assign(new Error("The file has a transient sharing lock."), { code: "EPERM" });
  let started!: () => void;
  const retrying = new Promise<void>((resolve) => { started = resolve; });
  const renaming = vi.spyOn(filesystem, "rename").mockImplementationOnce(async () => {
    started();
    throw sharing;
  }).mockImplementation(originalRename);
  syncBuiltinESMExports();
  simulatePlatform("win32");

  const older = writeMarkdown(destination, "Older snapshot\n", "lf");
  await retrying;
  const newer = writeMarkdown(destination, "Newer snapshot\n", "lf");
  await Promise.all([older, newer]);
  expect(renaming).toHaveBeenCalledTimes(3);
  expect(await readFile(destination, "utf8")).toBe("Newer snapshot\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
});

it.skipIf(nativePlatform !== "win32")("saves after a real Windows handle releases its sharing lock", async () => {
  const { directory, destination } = await fixture();
  const locker = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = "Stop"
    $handle = [System.IO.File]::Open($env:DOWNPAD_LOCKED_FILE, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [Console]::Out.WriteLine("locked")
      [Console]::Out.Flush()
      [Console]::ReadLine() | Out-Null
    } finally { $handle.Dispose() }
  `], { env: { ...process.env, DOWNPAD_LOCKED_FILE: destination } });
  const exited = new Promise<void>((resolve) => {
    locker.once("exit", () => resolve());
    locker.once("error", () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The Windows lock process did not become ready.")), 10_000);
      let output = "";
      locker.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("locked")) { clearTimeout(timeout); resolve(); }
      });
      locker.once("error", (error) => { clearTimeout(timeout); reject(error); });
      locker.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`The Windows lock process exited with ${code}.`));
      });
    });
    const originalRename = filesystem.rename;
    let sharingFailures = 0;
    vi.spyOn(filesystem, "rename").mockImplementation(async (...args) => {
      try { return await originalRename(...args); } catch (error: unknown) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        expect(["EPERM", "EACCES", "EBUSY"]).toContain(code);
        sharingFailures++;
        if (sharingFailures === 2) locker.stdin.end("\n");
        throw error;
      }
    });
    syncBuiltinESMExports();

    await writeMarkdown(destination, "Saved after sharing lock\n", "lf");
    expect(sharingFailures).toBeGreaterThanOrEqual(2);
    expect(await readFile(destination, "utf8")).toBe("Saved after sharing lock\n");
    expect(await readdir(directory)).toEqual(["note.md"]);
  } finally {
    if (!locker.stdin.writableEnded && !locker.stdin.destroyed) locker.stdin.end("\n");
    const forceExit = setTimeout(() => locker.kill(), 2_000);
    await exited;
    clearTimeout(forceExit);
  }
}, 15_000);
