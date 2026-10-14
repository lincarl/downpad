import { afterEach, expect, it, vi } from "vitest";
import filesystem, { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { writeMarkdown } from "./io";

const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const root = resolve("dev-temp", "electron-writes");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const aliases = process.platform === "win32" ? ["same path", "Windows case alias"] : ["same path", "symlink alias"];

it.each(aliases)("preserves save order through a %s while the older path lookup is blocked", async (alias) => {
  const directory = await fixtureDirectory();
  const target = join(directory, "note.md");
  await writeFile(target, "Original text\n");
  let olderPath = target;
  if (alias === "symlink alias") {
    olderPath = join(directory, "linked.md");
    await symlink("note.md", olderPath);
  } else if (alias === "Windows case alias") {
    olderPath = target.toUpperCase();
  }

  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const originalRealpath = filesystem.realpath;
  const lookup = vi.spyOn(filesystem, "realpath").mockImplementationOnce(async (path, options) => {
    entered!();
    await barrier;
    return originalRealpath(path, options);
  });
  syncBuiltinESMExports();

  const older = writeMarkdown(olderPath, "Older snapshot\n", "lf");
  await started;
  const newer = writeMarkdown(target, "Newer snapshot\n", "lf");
  try {
    // The second save must wait before resolving its path, including aliases.
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    release!();
    await Promise.allSettled([older, newer]);
  }
  await Promise.all([older, newer]);
  expect(await readFile(target, "utf8")).toBe("Newer snapshot\n");
  if (alias === "symlink alias") expect((await lstat(olderPath)).isSymbolicLink()).toBe(true);
});

it("keeps a newer short save after an older 16 MiB save to the actual filesystem", async () => {
  const path = join(await fixtureDirectory(), "large.md");
  const older = writeMarkdown(path, "x".repeat(16 * 1024 * 1024), "lf");
  const newer = writeMarkdown(path, "# Latest document\n", "crlf");
  const [olderMeta, newerMeta] = await Promise.all([older, newer]);
  expect(await readFile(path, "utf8")).toBe("# Latest document\r\n");
  expect(olderMeta.modifiedMs).toBeGreaterThan(0);
  expect(newerMeta.modifiedMs).toBe(Math.floor((await stat(path)).mtimeMs));
});

it("continues queued and later saves after a failed atomic replacement without leaving temporary files", async () => {
  const directory = await fixtureDirectory();
  const invalid = join(directory, "is-directory");
  await mkdir(invalid);
  const path = join(directory, "note.md");
  const failed = writeMarkdown(invalid, "Cannot replace a directory\n", "lf");
  const following = writeMarkdown(path, "Queued after failure\n", "lf");
  await expect(failed).rejects.toThrow();
  await following;
  expect(await readFile(path, "utf8")).toBe("Queued after failure\n");
  await writeMarkdown(path, "Saved after the queue drained\n", "lf");
  expect(await readFile(path, "utf8")).toBe("Saved after the queue drained\n");
  expect((await stat(invalid)).isDirectory()).toBe(true);
  expect((await readdir(directory)).sort()).toEqual(["is-directory", "note.md"]);
});
