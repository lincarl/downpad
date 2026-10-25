import { afterEach, describe, expect, it, vi } from "vitest";
import synchronousFilesystem from "node:fs";
import filesystem, { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { absolutePath, ensureAttachmentsDirectory, readMarkdown, writeAttachment, writeMarkdown } from "./io";
import { pageRanges, pdfOptions, printerOptions, validatePrintOptions } from "./printing";
import { clipboardPermission, externalUrl, ImageAccess, trustedPage } from "./security";
import { loadSettingsFile, normalizeSettings, patchSettingsToml, saveSettingsFile } from "./settings";
import { adoptLegacyData, ConfigStore, firstMatch, parseRecent, pathKey, RecentSearch } from "./storage";
import { watchPath } from "./watchers";

const temporaryDirectories: string[] = [];
async function fixtureDirectory(): Promise<string> {
  const root = resolve("dev-temp", "electron-backend");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Markdown file operations", () => {
  it("opens BOM/CRLF documents and saves full replacements with their original EOL", async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, "document.md");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Document\r\n\r\nOriginal\r\n")]));
    const opened = await readMarkdown(path);
    expect(opened).toMatchObject({ content: "# Document\n\nOriginal\n", eol: "crlf", hadBom: true });
    expect(opened.sizeBytes).toBe((await stat(path)).size);
    const saved = await writeMarkdown(path, "# Edited\n\n完整\n", opened.eol);
    expect(await readFile(path, "utf8")).toBe("# Edited\r\n\r\n完整\r\n");
    expect(saved.modifiedMs).toBe(Math.floor((await stat(path)).mtimeMs));
    expect((await readMarkdown(path)).hadBom).toBe(false);
    expect(await readdir(directory)).toEqual(["document.md"]);
  });

  it("rejects invalid UTF-8 rather than silently corrupting an opened document", async () => {
    const path = join(await fixtureDirectory(), "invalid.md");
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await expect(readMarkdown(path)).rejects.toThrow("UTF-8");
    expect(() => absolutePath("relative.md")).toThrow("absolute");
  });

  it.skipIf(process.platform === "win32")("saves through a relative symlink without replacing the link or leaving temporary files", async () => {
    const directory = await fixtureDirectory();
    const targetDirectory = join(directory, "originals");
    await mkdir(targetDirectory);
    const target = join(targetDirectory, "note.md");
    const linked = join(directory, "linked.md");
    await writeFile(target, "# Original\n");
    await symlink("originals/note.md", linked);
    const opened = await readMarkdown(linked);
    expect(opened.content).toBe("# Original\n");
    await writeMarkdown(linked, "# Saved through link\n", opened.eol);
    expect(await readFile(target, "utf8")).toBe("# Saved through link\n");
    expect(await readFile(linked, "utf8")).toBe("# Saved through link\n");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe("originals/note.md");
    expect(await readdir(targetDirectory)).toEqual(["note.md"]);
    expect((await readdir(directory)).sort()).toEqual(["linked.md", "originals"]);
  });

  it.skipIf(process.platform === "win32")("rejects dangling symlink saves and keeps the existing link intact", async () => {
    const directory = await fixtureDirectory();
    const linked = join(directory, "dangling.md");
    await symlink("missing.md", linked);
    await expect(writeMarkdown(linked, "Unsaved text\n", "lf")).rejects.toThrow("target does not exist");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe("missing.md");
    expect(await readdir(directory)).toEqual(["dangling.md"]);
  });

  it("keeps attachment names unique and rejects traversal", async () => {
    const directory = await fixtureDirectory();
    const document = join(directory, "note.md");
    const results = await Promise.all([
      writeAttachment(document, "attachments", "image.png", Uint8Array.of(1)),
      writeAttachment(document, "attachments", "image.png", Uint8Array.of(2)),
    ]);
    expect(new Set(results).size).toBe(2);
    expect((await Promise.all(results.map(async (path) => Array.from(await readFile(join(directory, path)))))).sort()).toEqual([[1], [2]]);
    await expect(ensureAttachmentsDirectory(document, "../outside")).rejects.toThrow("inside");
    await expect(writeAttachment(document, "attachments", "../unsafe.png", Uint8Array.of(3))).rejects.toThrow("file name");
  });

  it("observes external atomic replacement and continues watching subsequent saves", async () => {
    const path = join(await fixtureDirectory(), "watched.md");
    await writeFile(path, "initial\n");
    const changes: number[] = [];
    const stop = watchPath(path, (modified) => changes.push(modified));
    try {
      await writeMarkdown(path, "first\n", "lf");
      await expect.poll(() => changes.length).toBeGreaterThan(0);
      const before = changes.length;
      await writeMarkdown(path, "second\n", "lf");
      await expect.poll(() => changes.length).toBeGreaterThan(before);
      expect(await readFile(path, "utf8")).toBe("second\n");
    } finally { stop(); }
  });
});

describe("Existing settings and history compatibility", () => {
  it("retains TOML comments, unknown keys, key order, and quoted hashes", () => {
    const original = '# Personal settings\nfontFamily = "Example # Serif" # font comment\ntheme = "dark" # theme comment\nunknownKey = 42\n';
    const output = patchSettingsToml(original, { ...DEFAULT_SETTINGS, theme: "light", fontFamily: "Readable # Font" });
    expect(output).toContain('fontFamily = "Readable # Font" # font comment');
    expect(output).toContain('theme = "light" # theme comment');
    expect(output).toContain("# Personal settings\n");
    expect(parse(output)).toMatchObject({ theme: "light", fontFamily: "Readable # Font", unknownKey: 42 });
    expect(output.indexOf("fontFamily")).toBeLessThan(output.indexOf("theme"));
  });

  it("patches valid multiline values and inserts defaults before user tables", () => {
    const original = "fontFamily = '''Readable\nFont''' # preserve\n[custom]\nvalue = 1\n";
    const output = patchSettingsToml(original, DEFAULT_SETTINGS);
    expect(output).toContain('fontFamily = "Segoe UI" # preserve');
    expect(parse(output)).toMatchObject({ fontFamily: "Segoe UI", theme: "dark", custom: { value: 1 } });
  });

  it.each(['"theme"', "'theme'", '"th\\u0065me"'])("saves decoded quoted root key %s without duplicating it", async (key) => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const original = `# Keep quoted keys\n${key} = "light" # chosen theme\nunknownKey = 42\n`;
    await writeFile(path, original);
    await saveSettingsFile(path, { ...DEFAULT_SETTINGS, theme: "dark", hasSeenWelcome: true });
    const saved = await readFile(path, "utf8");
    expect(saved).toContain(`${key} = "dark" # chosen theme`);
    expect(saved).toContain("# Keep quoted keys\n");
    expect(parse(saved)).toMatchObject({ theme: "dark", unknownKey: 42, hasSeenWelcome: true });
    expect((saved.match(/# chosen theme/g) ?? []).length).toBe(1);
  });

  it.each([
    '[\n  "Readable",\n]',
    '[\n  ["Readable"],\n]',
    '{ nested = ["Readable"] }',
  ])("replaces a complete wrong-type settings value %s", async (value) => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const original = `# Font preference\nfontFamily = ${value} # font comment\nunknownKey = 42\n`;
    expect(parse(original).fontFamily).not.toBeTypeOf("string");
    await writeFile(path, original);
    await saveSettingsFile(path, DEFAULT_SETTINGS);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain('# Font preference\nfontFamily = "Segoe UI" # font comment\nunknownKey = 42\n');
    expect(parse(saved)).toMatchObject({ ...DEFAULT_SETTINGS, unknownKey: 42 });
  });

  it("preserves unknown multiline strings, arrays, dates, and tables containing settings-like text", async () => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const unknownRoot = 'unknownText = """\n[custom]\ntheme = "inside a string"\n[[other]]\n""" # text comment\n' +
      'unknownArray = [\n  ["nested"],\n  { theme = "inside an array" },\n]\n' +
      'savedOn = 2026-10-14T11:00:00+02:00\nlocalDate = 2026-10-14\n';
    const tables = '  [custom]\ntheme = "nested theme"\nfontFamily = "nested font"\n' +
      '[[custom.items]]\nvalue = 42\n[custom.empty]\n';
    const original = unknownRoot + 'theme = "light" # root theme\n' + tables;
    const parsed = parse(original);
    await writeFile(path, original);
    await saveSettingsFile(path, { ...DEFAULT_SETTINGS, theme: "dark", hasSeenWelcome: true });
    const saved = await readFile(path, "utf8");
    expect(saved).toContain(unknownRoot);
    expect(saved.endsWith(tables)).toBe(true);
    expect(saved).toContain('theme = "dark" # root theme');
    expect(parse(saved)).toEqual({ ...parsed, ...DEFAULT_SETTINGS, theme: "dark", hasSeenWelcome: true });
  });

  it("preserves BOM and CRLF while escaping quotes, backslashes, hashes, and controls", async () => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const original = '\uFEFF"fontFamily" = "Original" # font\r\nunknownKey = "keep"\r\n  [custom]\r\nvalue = 1\r\n';
    const fontFamily = 'Readable "Font" \\ # name\n\t\u007F';
    await writeFile(path, original);
    expect(await loadSettingsFile(path)).toMatchObject({ fontFamily: "Original" });
    await saveSettingsFile(path, { ...DEFAULT_SETTINGS, fontFamily });
    const saved = await readFile(path, "utf8");
    expect(saved.startsWith('\uFEFF"fontFamily" = ')).toBe(true);
    expect(saved).toContain('\\u007f" # font\r\n');
    expect(saved.replace(/\r\n/g, "")).not.toContain("\n");
    expect(saved.endsWith('  [custom]\r\nvalue = 1\r\n')).toBe(true);
    expect(parse(saved)).toMatchObject({ fontFamily, unknownKey: "keep", custom: { value: 1 } });
  });

  it("retains negative zero in accepted numeric settings", async () => {
    const path = join(await fixtureDirectory(), "settings.toml");
    await writeFile(path, 'editorFontScale = -0.0 # retain sign\nunknownKey = 42\n');
    const loaded = await loadSettingsFile(path);
    expect(Object.is(loaded.editorFontScale, -0)).toBe(true);
    await saveSettingsFile(path, { ...loaded, hasSeenWelcome: true });
    const saved = await readFile(path, "utf8");
    expect(saved).toContain('editorFontScale = -0.0 # retain sign');
    expect(Object.is(parse(saved).editorFontScale, -0)).toBe(true);
    expect(parse(saved)).toMatchObject({ unknownKey: 42, hasSeenWelcome: true });
  });

  it.each([
    'theme.child = "keep"\n',
    '[theme]\nchild = "keep"\n',
    '[[theme]]\nchild = "keep"\n',
  ])("preserves unsupported known-setting subtrees %s instead of writing a conflicting scalar", async (subtree) => {
    const directory = await fixtureDirectory();
    const path = join(directory, "settings.toml");
    const original = '# Preserve this unusual configuration\nunknownKey = "keep"\n' + subtree;
    expect(() => parse(original)).not.toThrow();
    await writeFile(path, original);
    await expect(saveSettingsFile(path, DEFAULT_SETTINGS)).rejects.toThrow("cannot be updated safely. The original file was preserved");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["settings.toml"]);
  });

  it("preserves settings when a string cannot be represented in TOML", async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, "settings.toml");
    const original = 'fontFamily = "Readable" # keep\nunknownKey = 42\n';
    await writeFile(path, original);
    await expect(saveSettingsFile(path, { ...DEFAULT_SETTINGS, fontFamily: "\uD800" }))
      .rejects.toThrow("cannot be updated safely. The original file was preserved");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["settings.toml"]);
  });

  it("uses read-only defaults and preserves original bytes when settings contain invalid UTF-8", async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, "settings.toml");
    const original = Buffer.concat([
      Buffer.from('# Keep unknown bytes '), Buffer.from([0xff]),
      Buffer.from('\nunknownKey = "keep"\ntheme = "light"\n'),
    ]);
    await writeFile(path, original);
    expect(await loadSettingsFile(path)).toEqual(DEFAULT_SETTINGS);
    expect(await readFile(path)).toEqual(original);
    await expect(saveSettingsFile(path, { ...DEFAULT_SETTINGS, hasSeenWelcome: true }))
      .rejects.toMatchObject({ message: expect.stringContaining("contains invalid UTF-8. Convert the file to UTF-8"), cause: expect.any(TypeError) });
    expect(await readFile(path)).toEqual(original);
    expect(await readdir(directory)).toEqual(["settings.toml"]);
  });

  it("preserves malformed settings when startup saves flags and resumes saving after syntax repair", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const malformed = '# Keep these comments\ntheme = "light"\nunknownKey = "keep me"\nfontFamily = "unfinished\n';
    await writeFile(store.settingsPath, malformed);
    const loaded = await store.settings();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    await expect(store.saveSettings({ ...loaded, hasSeenWelcome: true })).rejects.toThrow("contains invalid TOML. Fix the file's syntax");
    await expect(store.saveSettings({ ...loaded, hasSeenWelcome: true, hasCheckedDefaultHandler: true })).rejects.toThrow("contains invalid TOML");
    expect(await readFile(store.settingsPath, "utf8")).toBe(malformed);
    expect(await readdir(directory)).toEqual(["settings.toml"]);

    const repaired = malformed.replace('fontFamily = "unfinished\n', 'fontFamily = "Readable"\n');
    await writeFile(store.settingsPath, repaired);
    await store.saveSettings({ ...await store.settings(), hasSeenWelcome: true });
    const saved = await readFile(store.settingsPath, "utf8");
    expect(saved).toContain("# Keep these comments\n");
    expect(parse(saved)).toMatchObject({ theme: "light", unknownKey: "keep me", fontFamily: "Readable", hasSeenWelcome: true });
  });

  it("creates and saves complete defaults when the settings file does not exist", async () => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const settings = { ...DEFAULT_SETTINGS, hasSeenWelcome: true };
    await saveSettingsFile(path, settings);
    expect(await loadSettingsFile(path)).toEqual(settings);
    expect(parse(await readFile(path, "utf8"))).toMatchObject(settings);
  });

  it("propagates read failures without replacing an existing settings file", async () => {
    const path = join(await fixtureDirectory(), "settings.toml");
    const original = '# Keep existing configuration\ntheme = "light"\nunknownKey = "keep me"\n';
    await writeFile(path, original);
    const denied = Object.assign(new Error("Cannot read the existing settings file."), { code: "EACCES" });
    const reading = vi.spyOn(filesystem, "readFile").mockRejectedValueOnce(denied);
    try {
      syncBuiltinESMExports();
      await expect(saveSettingsFile(path, DEFAULT_SETTINGS)).rejects.toBe(denied);
    } finally {
      reading.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("fills missing settings, migrates old view values, and clamps invalid bounds", () => {
    expect(normalizeSettings({ defaultView: "raw", maxRetainedTabEditors: 100, printCopies: 0, printScalePercent: 900,
      recentFilesMaxRetained: 10, recentFilesVisibleCount: 20, theme: "invalid", mdHardWrap: true })).toMatchObject({
      defaultView: "split", maxRetainedTabEditors: 20, printCopies: 1, printScalePercent: 200,
      recentFilesMaxRetained: 10, recentFilesVisibleCount: 10, theme: "dark", mdHardWrap: false,
    });
  });

  it("bounds recent history settings to supported sizes and limits visible rows by retention", () => {
    expect(normalizeSettings({ recentFilesMaxRetained: 0, recentFilesVisibleCount: 0 }))
      .toMatchObject({ recentFilesMaxRetained: 10, recentFilesVisibleCount: 1 });
    expect(normalizeSettings({ recentFilesMaxRetained: Number.MAX_VALUE, recentFilesVisibleCount: Number.MAX_VALUE }))
      .toMatchObject({ recentFilesMaxRetained: 100_000, recentFilesVisibleCount: 100_000 });
    expect(normalizeSettings({ recentFilesMaxRetained: 50.9, recentFilesVisibleCount: 100 }))
      .toMatchObject({ recentFilesMaxRetained: 50, recentFilesVisibleCount: 50 });
    expect(normalizeSettings({ recentFilesMaxRetained: 500, recentFilesVisibleCount: 100 }))
      .toMatchObject({ recentFilesMaxRetained: 500, recentFilesVisibleCount: 100 });
  });

  it("normalizes recovery retention and intervals while preserving valid configured durations", () => {
    expect(normalizeSettings({ recoveryRetentionDays: 0, recoverySnapshotIntervalSeconds: 0, autosaveIntervalSeconds: 0 }))
      .toMatchObject({ recoveryRetentionDays: 1, recoverySnapshotIntervalSeconds: 2, autosaveIntervalSeconds: 5 });
    expect(normalizeSettings({ recoveryRetentionDays: 0.25, recoverySnapshotIntervalSeconds: 1.5, autosaveIntervalSeconds: 4.5 }))
      .toMatchObject({ recoveryRetentionDays: 1, recoverySnapshotIntervalSeconds: 2, autosaveIntervalSeconds: 5 });
    expect(normalizeSettings({ recoveryRetentionDays: 30, recoverySnapshotIntervalSeconds: 15, autosaveIntervalSeconds: 45 }))
      .toMatchObject({ recoveryRetentionDays: 30, recoverySnapshotIntervalSeconds: 15, autosaveIntervalSeconds: 45 });
    expect(normalizeSettings({ recoverySnapshotIntervalSeconds: Number.MAX_VALUE, autosaveIntervalSeconds: Number.MAX_VALUE }))
      .toMatchObject({ recoverySnapshotIntervalSeconds: 2_147_483, autosaveIntervalSeconds: 2_147_483 });
  });

  it("keeps recent crash recovery when hand-edited settings specify zero retention", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    await writeFile(store.settingsPath, "recoveryRetentionDays = 0\nrecoverySnapshotIntervalSeconds = 0\nautosaveIntervalSeconds = 0\n");
    const snapshot = { sessionId: "recent-crash", savedAt: new Date().toISOString(), filePath: null, markdown: "Recover this text\n", isDirty: true };
    await store.writeSnapshot(snapshot);
    const created = new Date(Date.now() - 60_000);
    await utimes(join(directory, "recovery", "recent-crash.json"), created, created);
    expect(await store.settings()).toMatchObject({ recoveryRetentionDays: 1, recoverySnapshotIntervalSeconds: 2, autosaveIntervalSeconds: 5 });
    expect(await store.snapshots()).toEqual([snapshot]);
  });

  it("migrates old recent rows and recognizes normalized paths", () => {
    expect(parseRecent('[{"path":"/notes.md","lastOpened":"2026-05-25T15:42:11Z","openCount":2}]')).toEqual([
      { path: "/notes.md", lastOpenedMs: Date.parse("2026-05-25T15:42:11Z"), favorite: false },
    ]);
    expect(pathKey("C:\\Notes\\folder\\..\\DOC.md", "win32")).toBe(pathKey("c:/notes/doc.md", "win32"));
    expect(parseRecent("broken JSON")).toEqual([]);
  });

  it("serializes concurrent history updates and preserves favorite state on reopen", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    await store.saveSettings({ ...DEFAULT_SETTINGS, recentFilesMaxRetained: 10 });
    const older = Array.from({ length: 8 }, (_, index) => ({
      path: join(directory, `older-${index + 1}.md`), lastOpenedMs: index + 1, favorite: false,
    }));
    await Promise.all(older.map(async (entry) => {
      await writeFile(entry.path, `# Older document ${entry.lastOpenedMs}\n`);
      await store.recordOpened(entry.path, entry.lastOpenedMs);
    }));
    const first = join(directory, "first.md");
    const second = join(directory, "second.md");
    const third = join(directory, "third.md");
    await Promise.all([store.recordOpened(first, 9), store.recordOpened(second, 10)]);
    await store.setFavorite(first, true);
    await store.recordOpened(first, 11);
    await store.recordOpened(third, 12);
    expect(await store.recent()).toEqual([
      { path: third, lastOpenedMs: 12, favorite: false }, { path: first, lastOpenedMs: 11, favorite: true },
      { path: second, lastOpenedMs: 10, favorite: false }, ...older.slice(1).reverse(),
    ]);
    expect(JSON.parse(await readFile(join(directory, "recent.json"), "utf8")) as unknown).toEqual([
      { p: third, t: 12 }, { p: first, t: 11, f: true }, { p: second, t: 10 },
      ...older.slice(1).reverse().map((entry) => ({ p: entry.path, t: entry.lastOpenedMs })),
    ]);
    await expect(store.setFavorite(older[0]!.path, true)).rejects.toThrow("not in recent");
  });

  it("preserves existing history when opening a file with hand-edited zero retention settings", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const first = join(directory, "earlier.md");
    const second = join(directory, "previous.md");
    const next = join(directory, "newly-opened.md");
    await Promise.all([first, second, next].map((path) => writeFile(path, `# ${basename(path)}\n`)));
    await store.recordOpened(first, 1);
    await store.recordOpened(second, 2);
    await store.setFavorite(first, true);
    await writeFile(store.settingsPath, "recentFilesMaxRetained = 0\nrecentFilesVisibleCount = 0\n");
    await store.recordOpened(next, 3);
    expect(await store.settings()).toMatchObject({ recentFilesMaxRetained: 10, recentFilesVisibleCount: 1 });
    expect(await store.recent()).toEqual([
      { path: next, lastOpenedMs: 3, favorite: false },
      { path: second, lastOpenedMs: 2, favorite: false },
      { path: first, lastOpenedMs: 1, favorite: true },
    ]);
    expect(JSON.parse(await readFile(join(directory, "recent.json"), "utf8")) as unknown).toEqual([
      { p: next, t: 3 }, { p: second, t: 2 }, { p: first, t: 1, f: true },
    ]);
  });

  it("loads valid recovery, removes expired/corrupt snapshots, and blocks session traversal", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const snapshot = { sessionId: "synthetic-session", savedAt: new Date().toISOString(), filePath: null, markdown: "# Unsaved\n", isDirty: true };
    await store.writeSnapshot(snapshot);
    await store.writeSnapshot({ ...snapshot, sessionId: "expired" });
    const old = new Date(Date.now() - 30 * 86_400_000);
    await utimes(join(directory, "recovery", "expired.json"), old, old);
    await writeFile(join(directory, "recovery", "broken.json"), "not-json");
    await writeFile(join(directory, "recovery", "invalid.json"), JSON.stringify({ ...snapshot, markdown: null }));
    await writeFile(join(directory, "recovery", "traversal.json"), JSON.stringify({ ...snapshot, sessionId: "../outside" }));
    expect(await store.snapshots()).toEqual([snapshot]);
    expect(await readdir(join(directory, "recovery"))).toEqual(["synthetic-session.json"]);
    await expect(store.writeSnapshot({ ...snapshot, sessionId: "../outside" })).rejects.toThrow("invalid");
    await expect(store.deleteSnapshot("../outside")).rejects.toThrow("invalid");
    await store.deleteSnapshot(snapshot.sessionId);
    expect(await store.snapshots()).toEqual([]);
  });

  it.each([
    { operation: "stat", code: "EIO" },
    { operation: "stat", code: "EACCES" },
    { operation: "readFile", code: "EIO" },
    { operation: "readFile", code: "EACCES" },
  ])("preserves recovery after $operation fails with $code and loads it on retry", async ({ operation, code }) => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const snapshot = { sessionId: "recoverable", savedAt: new Date().toISOString(), filePath: null, markdown: "# Unsaved café\r\n完整\r\n", isDirty: true };
    const healthy = { ...snapshot, sessionId: "healthy", markdown: "Other unsaved work\n" };
    await store.writeSnapshot(healthy);
    await store.writeSnapshot(snapshot);
    const recovery = join(directory, "recovery");
    const path = join(recovery, "recoverable.json");
    const older = new Date(Date.now() - 60_000);
    await utimes(join(recovery, "healthy.json"), older, older);
    const original = await readFile(path);
    const failure = Object.assign(new Error("Temporary filesystem failure"), { code });
    const originalRead = filesystem.readFile;
    const originalStat = filesystem.stat;
    const failingCall = operation === "readFile"
      ? vi.spyOn(filesystem, "readFile").mockImplementation(async (...args) => {
        if (args[0] === path) throw failure;
        return originalRead(...args);
      })
      : vi.spyOn(filesystem, "stat").mockImplementation(async (...args) => {
        if (args[0] === path) throw failure;
        return originalStat(...args);
      });
    try {
      syncBuiltinESMExports();
      expect(await store.snapshots()).toEqual([healthy]);
      expect(await readdir(recovery)).toContain("recoverable.json");
      expect(await originalRead(path)).toEqual(original);
    } finally {
      failingCall.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await store.snapshots()).toEqual([snapshot, healthy]);
    expect(await readFile(path)).toEqual(original);
  });

  it("retains the 50 newest readable snapshots by mtime without pruning an unreadable neighbor", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const now = Date.now();
    const snapshots = Array.from({ length: 51 }, (_, index) => ({
      sessionId: `session-${index}`, savedAt: new Date(now - index * 1_000).toISOString(),
      filePath: null, markdown: `Unsaved document ${index}\n`, isDirty: true,
    }));
    const recovery = join(directory, "recovery");
    for (const [index, snapshot] of snapshots.entries()) {
      await store.writeSnapshot(snapshot);
      const modified = new Date(now - 100_000 + index * 1_000);
      await utimes(join(recovery, `${snapshot.sessionId}.json`), modified, modified);
    }
    const unreadable = { ...snapshots[0]!, sessionId: "unreadable", savedAt: "2000-01-01T00:00:00.000Z" };
    await store.writeSnapshot(unreadable);
    const path = join(recovery, "unreadable.json");
    const original = await readFile(path);
    const originalRead = filesystem.readFile;
    const reading = vi.spyOn(filesystem, "readFile").mockImplementation(async (...args) => {
      if (args[0] === path) throw new Error("Snapshot temporarily unavailable");
      return originalRead(...args);
    });
    try {
      syncBuiltinESMExports();
      expect(await store.snapshots()).toEqual(snapshots.slice(1).reverse());
      expect((await readdir(recovery)).sort()).toEqual([
        ...snapshots.slice(1).map((snapshot) => `${snapshot.sessionId}.json`), "unreadable.json",
      ].sort());
      expect(await originalRead(path)).toEqual(original);
    } finally {
      reading.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await store.snapshots()).toEqual([unreadable, ...snapshots.slice(2).reverse()]);
    expect(await readFile(path)).toEqual(original);
    expect(await readdir(recovery)).toHaveLength(50);
  });

  it("finishes a pending snapshot before its clean-shutdown deletion", async () => {
    const directory = await fixtureDirectory();
    const store = new ConfigStore(directory);
    await store.initialize();
    const snapshot = { sessionId: "closing-session", savedAt: new Date().toISOString(), filePath: null, markdown: "Unsaved text\n", isDirty: true };
    await Promise.all([store.writeSnapshot(snapshot), store.deleteSnapshot(snapshot.sessionId)]);
    expect(await store.snapshots()).toEqual([]);
  });
});

describe("Data that the app kept as md-easy, its earlier name", () => {
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  /** An md-easy folder with the app's files and one of Chromium's, beside the
   *  Downpad folder that Electron has already created. */
  async function folders(): Promise<{ legacy: string; directory: string }> {
    const root = await fixtureDirectory();
    const legacy = join(root, "md-easy");
    const directory = join(root, "Downpad");
    await mkdir(join(legacy, "recovery"), { recursive: true });
    await mkdir(directory);
    await writeFile(join(legacy, "settings.toml"), 'theme = "nord"\n');
    await writeFile(join(legacy, "recent.json"), "[]");
    await writeFile(join(legacy, "recovery", "session.json"), "{}");
    await writeFile(join(legacy, "Custom Dictionary.txt"), "Downpad\n");
    await writeFile(join(legacy, "Local State"), "{}");
    return { legacy, directory };
  }

  it("moves the app's files into the folder that Electron created", async () => {
    const { legacy, directory } = await folders();
    expect(adoptLegacyData(legacy, directory)).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(["Custom Dictionary.txt", "recent.json", "recovery", "settings.toml"]);
    expect(await readFile(join(directory, "settings.toml"), "utf8")).toBe('theme = "nord"\n');
    expect(await readFile(join(directory, "recovery", "session.json"), "utf8")).toBe("{}");
    expect(await readdir(legacy)).toEqual(["Local State"]);
  });

  it("keeps the files that the new folder already has and takes over the rest", async () => {
    const { legacy, directory } = await folders();
    await writeFile(join(directory, "recent.json"), '[{"p":"/notes.md","t":1}]');
    expect(adoptLegacyData(legacy, directory)).toBe(true);
    expect(await readFile(join(directory, "recent.json"), "utf8")).toBe('[{"p":"/notes.md","t":1}]');
    expect((await readdir(directory)).sort()).toEqual(["Custom Dictionary.txt", "recent.json", "recovery", "settings.toml"]);
    expect((await readdir(legacy)).sort()).toEqual(["Local State", "recent.json"]);
    expect(adoptLegacyData(legacy, directory)).toBe(false);
    expect(await readFile(join(directory, "recent.json"), "utf8")).toBe('[{"p":"/notes.md","t":1}]');
  });

  it("copies a file that cannot be moved and does not copy it again", async () => {
    const { legacy, directory } = await folders();
    vi.spyOn(synchronousFilesystem, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("The file is in use."), { code: "EPERM" });
    });
    syncBuiltinESMExports();
    expect(adoptLegacyData(legacy, directory)).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(["Custom Dictionary.txt", "recent.json", "recovery", "settings.toml"]);
    expect(await readFile(join(directory, "settings.toml"), "utf8")).toBe('theme = "nord"\n');
    expect((await readdir(legacy)).sort()).toEqual(["Local State", "settings.toml"]);
    await writeFile(join(directory, "settings.toml"), 'theme = "light"\n');
    expect(adoptLegacyData(legacy, directory)).toBe(false);
    expect(await readFile(join(directory, "settings.toml"), "utf8")).toBe('theme = "light"\n');
  });

  it("tries a file again on the next launch when it can be neither moved nor copied", async () => {
    const { legacy, directory } = await folders();
    const failure = Object.assign(new Error("Access is denied."), { code: "EACCES" });
    vi.spyOn(synchronousFilesystem, "renameSync").mockImplementationOnce(() => { throw failure; });
    vi.spyOn(synchronousFilesystem, "cpSync").mockImplementationOnce(() => { throw failure; });
    syncBuiltinESMExports();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(adoptLegacyData(legacy, directory)).toBe(false);
    expect(logged).toHaveBeenCalledWith("Downpad could not take over md-easy's settings.toml", failure);
    expect((await readdir(directory)).sort()).toEqual(["Custom Dictionary.txt", "recent.json", "recovery"]);
    expect(adoptLegacyData(legacy, directory)).toBe(true);
    expect(await readFile(join(directory, "settings.toml"), "utf8")).toBe('theme = "nord"\n');
    expect(await readdir(legacy)).toEqual(["Local State"]);
  });
});

describe("Recent document search", () => {
  it("keeps Unicode match offsets correct and extracts the first matching line", () => {
    expect(firstMatch("alpha\nİstanbul HELLO world\ngamma", "hello", false)).toEqual({ line: 2, snippet: "İstanbul HELLO world" });
    expect(firstMatch("Graph\ngraph", "graph", true)?.line).toBe(2);
    expect(firstMatch("no matching text", "missing", false)).toBeNull();
    expect(firstMatch("x".repeat(200) + " NEEDLE " + "y".repeat(200), "needle", false)?.snippet).toMatch(/^….*NEEDLE.*…$/);
  });

  it("streams file hits, skips unreadable files, and responds to cancellation", async () => {
    const directory = await fixtureDirectory();
    const first = join(directory, "first.md");
    const second = join(directory, "second.md");
    await writeFile(first, "heading\nMATCH one\n");
    await writeFile(second, "MATCH two\n");
    const search = new RecentSearch();
    const hits: unknown[] = [];
    const summary = await search.run("search-one", [first, second], "match", false, (hit) => {
      hits.push(hit); search.cancel("search-one");
    });
    expect(summary).toEqual({ scanned: 1, matched: 1, cancelled: true });
    expect(hits).toEqual([{ kind: "content", path: first, line: 2, snippet: "MATCH one", scanned: 1, matched: 1 }]);
    expect(await search.run("search-two", [join(directory, "missing.md"), second], "missing", false, () => {}))
      .toEqual({ scanned: 1, matched: 0, cancelled: false });
  });
});

describe("Native print setup", () => {
  const options = { printerName: "test-printer", copies: 2, orientation: "landscape" as const, pageWidthIn: 11, pageHeightIn: 8.5, pageRanges: "1-3,5" };

  it("converts UI page ranges and page dimensions for Electron's separate print APIs", () => {
    expect(pageRanges(options.pageRanges)).toEqual([{ from: 0, to: 2 }, { from: 4, to: 4 }]);
    expect(printerOptions(options)).toMatchObject({ deviceName: "test-printer", copies: 2, landscape: true,
      margins: { marginType: "none" }, pageSize: { width: 215900, height: 279400 } });
    expect(pdfOptions(options)).toMatchObject({ pageRanges: "1-3,5", landscape: true,
      pageSize: { width: 8.5, height: 11 }, displayHeaderFooter: false });
  });

  it("rejects inverted/zero ranges and invalid dimensions before starting a job", () => {
    expect(() => pageRanges("3-1")).toThrow();
    expect(() => pageRanges("0")).toThrow();
    expect(() => pageRanges("all")).toThrow();
    expect(() => validatePrintOptions({ ...options, copies: 0 })).toThrow("invalid");
    expect(() => validatePrintOptions({ ...options, pageWidthIn: Number.NaN })).toThrow("invalid");
  });
});

describe("Desktop page and image access", () => {
  it("rejects unexpected renderer pages and unsafe external protocols", () => {
    expect(trustedPage("file:///app/dist/index.html#document", "file:///app/dist/index.html")).toBe(true);
    expect(trustedPage("file:///etc/passwd", "file:///app/dist/index.html")).toBe(false);
    expect(trustedPage("http://127.0.0.1:1420/other", "http://127.0.0.1:1420/")).toBe(false);
    expect(externalUrl("https://example.com/document")).toBe("https://example.com/document");
    expect(() => externalUrl("file:///etc/passwd")).toThrow("not supported");
    expect(() => externalUrl("javascript:alert(1)")).toThrow("not supported");
    const entry = "file:///app/dist/index.html";
    expect(clipboardPermission("clipboard-sanitized-write", entry, entry, true)).toBe(true);
    expect(clipboardPermission("clipboard-read", entry, entry, true)).toBe(true);
    expect(clipboardPermission("clipboard-read", "https://example.com", entry, true)).toBe(false);
    expect(clipboardPermission("clipboard-read", entry, entry, false)).toBe(false);
    expect(clipboardPermission("geolocation", entry, entry, true)).toBe(false);
  });

  it("authorizes linked images one at a time and rejects unknown URLs or changed symlink targets", async () => {
    const directory = await fixtureDirectory();
    const documentDirectory = join(directory, "documents");
    await mkdir(documentDirectory);
    const image = join(documentDirectory, "image.png");
    const external = join(directory, "outside.png");
    await writeFile(image, Uint8Array.of(1));
    await writeFile(external, Uint8Array.of(2));
    const access = new ImageAccess();
    const authorized = new URL((await access.imageUrl(image))!);
    expect(await access.resolveImage(authorized.searchParams.get("token")!)).toBe(image);
    await expect(access.resolveImage("invented-token")).rejects.toThrow("not been authorized");
    await expect(access.resolveImage(external)).rejects.toThrow("not been authorized");
    const shared = new URL((await access.imageUrl(external))!);
    expect(await access.resolveImage(shared.searchParams.get("token")!)).toBe(external);
    if (process.platform !== "win32") {
      const linked = join(documentDirectory, "linked.png");
      await symlink(external, linked);
      const linkedUrl = new URL((await access.imageUrl(linked))!);
      expect(await access.resolveImage(linkedUrl.searchParams.get("token")!)).toBe(external);
      await rm(external);
      await symlink(image, external);
      await expect(access.resolveImage(shared.searchParams.get("token")!)).rejects.toThrow("changed");
    }
    const unsafe = join(documentDirectory, "script.js");
    await writeFile(unsafe, "alert(1)");
    await expect(access.imageUrl(unsafe)).rejects.toThrow("Only local images");
  });

  it("answers a missing image with null and still rejects invalid paths", async () => {
    const directory = await fixtureDirectory();
    const image = join(directory, "image.png");
    await writeFile(image, Uint8Array.of(1));
    const access = new ImageAccess();
    // A rejection here would make Electron log a handler error for every missing image.
    await expect(access.imageUrl(join(directory, "missing.png"))).resolves.toBeNull();
    await expect(access.imageUrl(join(image, "child.png"))).resolves.toBeNull();
    await expect(access.imageUrl("relative.png")).rejects.toThrow("absolute file path");
  });
});
