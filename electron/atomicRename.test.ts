import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import filesystem, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { writeAtomic, writeMarkdown } from "./io";

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
