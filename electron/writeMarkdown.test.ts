import { afterEach, expect, it, vi } from "vitest";
import filesystem, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

/** A promise and the function that settles it, for a step a test holds. */
function barrier(): { reached: Promise<void>; enter: () => void; passed: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { enter = resolve; });
  const passed = new Promise<void>((resolve) => { release = resolve; });
  return { reached, enter, passed, release };
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

// Windows and macOS ignore case by default, so another letter case is the same file there.
const spellings = process.platform === "win32" || process.platform === "darwin" ? ["same path", "case alias"] : ["same path"];

it.each(spellings)("keeps the order of writes through the %s while the older one's path does not resolve", async (spelling) => {
  const directory = await fixtureDirectory();
  const target = join(directory, "note.md");
  await writeFile(target, "Original text\n");
  const olderPath = spelling === "case alias" ? target.toUpperCase() : target;

  const lookup = barrier();
  const originalRealpath = filesystem.realpath;
  const resolveSpy = vi.spyOn(filesystem, "realpath").mockImplementationOnce(async (path, options) => {
    lookup.enter();
    await lookup.passed;
    return originalRealpath(path, options);
  });
  syncBuiltinESMExports();

  const older = writeMarkdown(olderPath, "Older snapshot\n", "lf");
  await lookup.reached;
  const newer = writeMarkdown(target, "Newer snapshot\n", "lf");
  try {
    // The second save must wait before resolving its path.
    expect(await settlesWithin(newer, 50)).toBe(false);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  } finally {
    lookup.release();
    await Promise.allSettled([older, newer]);
  }
  await Promise.all([older, newer]);
  expect(await readFile(target, "utf8")).toBe("Newer snapshot\n");
});

it("holds up no write of another file while a write's path does not resolve, as on a drive that went away", async () => {
  const gone = await fixtureDirectory();
  const local = join(await fixtureDirectory(), "local.md");
  const lookup = barrier();
  const originalRealpath = filesystem.realpath;
  vi.spyOn(filesystem, "realpath").mockImplementation(async (path, options) => {
    if (String(path).startsWith(gone)) {
      lookup.enter();
      await lookup.passed;
    }
    return originalRealpath(path, options);
  });
  syncBuiltinESMExports();

  const stuck = writeMarkdown(join(gone, "remote.md"), "Remote text\n", "lf");
  await lookup.reached;
  try {
    expect(await settlesWithin(writeMarkdown(local, "First local text\n", "lf"), 2000)).toBe(true);
    expect(await settlesWithin(writeMarkdown(local, "Second local text\n", "crlf"), 2000)).toBe(true);
    expect(await readFile(local, "utf8")).toBe("Second local text\r\n");
    expect(await settlesWithin(stuck, 50)).toBe(false);
  } finally {
    lookup.release();
    await stuck.catch(() => {});
  }
  expect(await readFile(join(gone, "remote.md"), "utf8")).toBe("Remote text\n");
});

it.skipIf(process.platform === "win32")("never writes one file through two spellings at the same time", async () => {
  const directory = await fixtureDirectory();
  const target = join(directory, "note.md");
  const linked = join(directory, "linked.md");
  await writeFile(target, "Original text\n");
  await symlink("note.md", linked);

  // The older write holds the file once its path resolved, in its staging.
  const staging = barrier();
  const originalOpen = filesystem.open;
  const openSpy = vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
    staging.enter();
    await staging.passed;
    return originalOpen(...args);
  });
  syncBuiltinESMExports();

  const older = writeMarkdown(linked, "Older snapshot\n", "lf");
  await staging.reached;
  const newer = writeMarkdown(target, "Newer snapshot\n", "lf");
  try {
    expect(await settlesWithin(newer, 50)).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(1);
  } finally {
    staging.release();
    await Promise.allSettled([older, newer]);
  }
  await Promise.all([older, newer]);
  expect(await readFile(target, "utf8")).toBe("Newer snapshot\n");
  expect((await lstat(linked)).isSymbolicLink()).toBe(true);
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

it.each(["partial write", "sync"])("preserves the original and cleans staging after a %s failure", async (fault) => {
  const directory = await fixtureDirectory();
  const path = join(directory, "note.md");
  const original = Buffer.from("\ufeff# Saved note\r\nOriginal café\r\n");
  await writeFile(path, original);
  const failure = Object.assign(new Error(`${fault} failed`), { code: "EIO" });
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    if (fault === "partial write") {
      const originalWrite = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementationOnce(async (data) => {
        if (typeof data !== "string") throw new Error("The fixture expects markdown text.");
        await originalWrite(data.slice(0, Math.floor(data.length / 2)));
        throw failure;
      });
    } else {
      vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
    }
    return file;
  });
  syncBuiltinESMExports();

  await expect(writeMarkdown(path, "Replacement that must not be published\n", "lf")).rejects.toBe(failure);
  expect(await readFile(path)).toEqual(original);
  expect(await readdir(directory)).toEqual(["note.md"]);

  await writeMarkdown(path, "# Saved after failure\n", "crlf");
  expect(await readFile(path, "utf8")).toBe("# Saved after failure\r\n");
  expect(await readdir(directory)).toEqual(["note.md"]);
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

it.skipIf(process.platform === "win32").each([
  { label: "0600", mode: 0o600 },
  { label: "0755", mode: 0o755 },
  // The umask strips group and other write bits from a newly created file.
  { label: "0664", mode: 0o664 },
  { label: "0666", mode: 0o666 },
])("keeps the file mode $label after a save", async ({ mode }) => {
  const directory = await fixtureDirectory();
  const path = join(directory, "note.md");
  await writeFile(path, "Original text\n");
  await chmod(path, mode);
  // A fixed umask keeps the result independent of the shell that runs the tests.
  const umask = process.umask(0o022);
  try {
    await writeMarkdown(path, "Saved text\n", "lf");
  } finally {
    process.umask(umask);
  }
  expect(await readFile(path, "utf8")).toBe("Saved text\n");
  expect((await stat(path)).mode & 0o777).toBe(mode);
  expect(await readdir(directory)).toEqual(["note.md"]);
});
