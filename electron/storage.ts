import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { FileStat, SearchHit, SearchSummary, Snapshot } from "../src/ipc/contracts";
import type { RecentEntry, Settings } from "../src/state/types";
import { absolutePath, readMarkdown, writeAtomic } from "./io";
import { loadSettingsFile, saveSettingsFile } from "./settings";

interface DiskEntry { p: string; t: number; f?: boolean }

export function pathKey(path: string, platform = process.platform): string {
  const key = normalize(path.replace(/\\/g, "/"));
  return platform === "win32" ? key.toLowerCase() : key;
}

export function parseRecent(text: string): RecentEntry[] {
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.flatMap((value: unknown): RecentEntry[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.p === "string" && typeof row.t === "number" && Number.isFinite(row.t)) {
        return [{ path: row.p, lastOpenedMs: row.t, favorite: row.f === true }];
      }
      if (typeof row.path === "string" && typeof row.lastOpened === "string") {
        return [{ path: row.path, lastOpenedMs: Date.parse(row.lastOpened) || 0, favorite: false }];
      }
      return [];
    });
  } catch { return []; }
}

export function validateSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("A recovery snapshot is required.");
  const source = value as Record<string, unknown>;
  if (typeof source.sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(source.sessionId) ||
    typeof source.savedAt !== "string" || !Number.isFinite(Date.parse(source.savedAt)) ||
    !(source.filePath === null || typeof source.filePath === "string") ||
    typeof source.markdown !== "string" || typeof source.isDirty !== "boolean") {
    throw new Error("The recovery snapshot is invalid.");
  }
  return {
    sessionId: source.sessionId, savedAt: source.savedAt, filePath: source.filePath,
    markdown: source.markdown, isDirty: source.isDirty,
  };
}

/** The files in the user data folder that hold the user's data: settings,
 *  recent history, window geometry, crash recovery snapshots and the words
 *  added to the spell checker's dictionary, which Chromium keeps. */
const DATA_FILES = ["settings.toml", "recent.json", "window-state.json", "recovery", "Custom Dictionary.txt"];

/** The start of the name of each folder in which adoptLegacyData copies a file
 *  before it renames the copy into place. */
const COPY_FOLDER_PREFIX = ".md-easy-copy-";

/** Remove a copy folder if possible. One that stays only takes space, so a
 *  failure, such as a file another program holds open on Windows, never stops
 *  the migration or the launch. */
function removeCopyFolder(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); }
  catch (error) { console.error(`Downpad could not remove ${path}`, error); }
}

/** Move the files in DATA_FILES from the user data folder that the app kept as
 *  md-easy, its earlier name, to `directory`. Electron creates `directory`
 *  before the app's code runs, so each file moves only while `directory` lacks
 *  it, and nothing Downpad wrote is replaced. A file that cannot be moved, for
 *  example while a running md-easy holds it open on Windows, is copied instead
 *  and the original stays. A file that can be neither moved nor copied stays in
 *  the old folder and is tried again on a later launch, unless Downpad has made
 *  its own by then, as it does with its settings and recovery folder at
 *  startup. Chromium's own files stay in the old folder. Returns whether the
 *  app took over md-easy's settings. Call it only from the launch that holds
 *  the single-instance lock, so that two launches never move the same files. */
export function adoptLegacyData(legacy: string, directory: string): boolean {
  if (!existsSync(legacy)) return false;
  // Only one launch migrates, so a copy folder found now was left by a launch
  // that stopped during its copy. Its files may be outdated.
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    if (entry.startsWith(COPY_FOLDER_PREFIX)) removeCopyFolder(join(directory, entry));
  }
  let adoptedSettings = false;
  for (const name of DATA_FILES) {
    const source = join(legacy, name);
    const target = join(directory, name);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(directory, { recursive: true });
    try { renameSync(source, target); }
    catch {
      // Copy into a new folder of this attempt's own and rename the copy into
      // place, so a failed copy only removes its own files, and no copy ever
      // lands among files that an earlier attempt left.
      let folder: string | undefined;
      try {
        folder = mkdtempSync(join(directory, COPY_FOLDER_PREFIX));
        const copy = join(folder, name);
        cpSync(source, copy, { recursive: true });
        renameSync(copy, target);
      } catch (error) {
        console.error(`Downpad could not take over md-easy's ${name}`, error);
        continue;
      } finally {
        if (folder) removeCopyFolder(folder);
      }
    }
    if (name === "settings.toml") adoptedSettings = true;
  }
  return adoptedSettings;
}

/** Persist the existing user settings, recent history, and crash recovery formats. */
export class ConfigStore {
  readonly settingsPath: string;
  private pendingWrite: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {
    this.settingsPath = join(absolutePath(directory), "settings.toml");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.settings();
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pendingWrite.then(action);
    this.pendingWrite = result.catch(() => {});
    return result;
  }

  async settings(): Promise<Settings> {
    await this.pendingWrite;
    return loadSettingsFile(this.settingsPath);
  }

  saveSettings(settings: unknown): Promise<void> {
    return this.mutate(() => saveSettingsFile(this.settingsPath, settings));
  }

  private async loadRecent(): Promise<RecentEntry[]> {
    const entries = parseRecent(await readFile(join(this.directory, "recent.json"), "utf8").catch(() => "[]"));
    return entries.sort((a, b) => b.lastOpenedMs - a.lastOpenedMs);
  }

  async recent(limit?: number): Promise<RecentEntry[]> {
    await this.pendingWrite;
    const entries = await this.loadRecent();
    return limit === undefined ? entries : entries.slice(0, Math.max(0, Math.floor(limit)));
  }

  private async storeRecent(entries: RecentEntry[]): Promise<void> {
    const disk: DiskEntry[] = entries.map((row) => ({ p: row.path, t: row.lastOpenedMs, ...(row.favorite ? { f: true } : {}) }));
    await writeAtomic(join(this.directory, "recent.json"), JSON.stringify(disk));
  }

  recordOpened(path: string, openedAtMs: number): Promise<RecentEntry> {
    return this.mutate(async () => {
      const entries = await this.loadRecent();
      const previous = entries.find((row) => pathKey(row.path) === pathKey(path));
      const entry = { path, lastOpenedMs: openedAtMs, favorite: previous?.favorite ?? false };
      const next = [entry, ...entries.filter((row) => pathKey(row.path) !== pathKey(path))]
        .sort((a, b) => b.lastOpenedMs - a.lastOpenedMs);
      const settings = await loadSettingsFile(this.settingsPath);
      await this.storeRecent(next.slice(0, settings.recentFilesMaxRetained));
      return entry;
    });
  }

  removeRecent(path: string): Promise<void> {
    return this.mutate(async () => this.storeRecent((await this.loadRecent()).filter((row) => pathKey(row.path) !== pathKey(path))));
  }

  setFavorite(path: string, favorite: boolean): Promise<RecentEntry> {
    return this.mutate(async () => {
      const entries = await this.loadRecent();
      const entry = entries.find((row) => pathKey(row.path) === pathKey(path));
      if (!entry) throw new Error("The file is not in recent history.");
      entry.favorite = favorite;
      await this.storeRecent(entries);
      return entry;
    });
  }

  private async recoveryDirectory(): Promise<string> {
    const directory = join(this.directory, "recovery");
    await mkdir(directory, { recursive: true });
    return directory;
  }

  async writeSnapshot(value: unknown): Promise<void> {
    const snapshot = validateSnapshot(value);
    return this.mutate(async () => {
      await writeAtomic(join(await this.recoveryDirectory(), `${snapshot.sessionId}.json`), JSON.stringify(snapshot));
    });
  }

  async deleteSnapshot(sessionId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("The session ID is invalid.");
    return this.mutate(async () => {
      const path = join(await this.recoveryDirectory(), `${sessionId}.json`);
      await unlink(path).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    });
  }

  /** List retained snapshots, leaving unreadable files for a later attempt. */
  async snapshots(): Promise<Snapshot[]> {
    const directory = await this.recoveryDirectory();
    const settings = await this.settings();
    const oldest = Date.now() - settings.recoveryRetentionDays * 86_400_000;
    const snapshots: { path: string; modified: number; snapshot: Snapshot }[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.mtimeMs < oldest) { await unlink(path).catch(() => {}); continue; }
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      try {
        const snapshot = validateSnapshot(JSON.parse(text) as unknown);
        snapshots.push({ path, modified: info.mtimeMs, snapshot });
      } catch { await unlink(path).catch(() => {}); }
    }
    snapshots.sort((a, b) => b.modified - a.modified);
    await Promise.all(snapshots.slice(50).map((row) => unlink(row.path).catch(() => {})));
    return snapshots.slice(0, 50).map((row) => row.snapshot);
  }
}

export async function statFiles(paths: string[]): Promise<FileStat[]> {
  return Promise.all(paths.map(async (path) => {
    absolutePath(path);
    const [info, parent] = await Promise.all([
      stat(path).catch(() => null), stat(dirname(path)).catch(() => null),
    ]);
    return { path, exists: info?.isFile() ?? false, sizeBytes: info?.isFile() ? info.size : 0, folderExists: parent?.isDirectory() ?? false };
  }));
}

export function firstMatch(content: string, query: string, caseSensitive: boolean): { line: number; snippet: string } | null {
  const fold = (text: string): string => caseSensitive ? text : Array.from(text, (char) => char.toLowerCase()).join("");
  const needle = fold(query);
  if (!needle) return null;
  const lines = content.split(/\r\n?|\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const chars = Array.from(lines[lineIndex]!);
    const origins: number[] = [];
    const folded = chars.map((char, originalIndex) => {
      const lower = fold(char);
      for (let index = 0; index < lower.length; index++) origins.push(originalIndex);
      return lower;
    }).join("");
    const match = folded.indexOf(needle);
    if (match < 0) continue;
    const at = origins[match]!;
    const start = Math.max(0, at - 30);
    const end = Math.min(chars.length, Math.max(start + 160, at + Array.from(query).length));
    const snippet = (start > 0 ? "…" : "") + chars.slice(start, end).join("").replace(/[\u0000-\u001f\u007f]/g, " ") + (end < chars.length ? "…" : "");
    return { line: lineIndex + 1, snippet };
  }
  return null;
}

export class RecentSearch {
  private readonly tokens = new Map<string, { cancelled: boolean }>();

  cancel(searchId: string): void { const token = this.tokens.get(searchId); if (token) token.cancelled = true; }

  async run(searchId: string, paths: string[], query: string, caseSensitive: boolean, emit: (hit: SearchHit) => void): Promise<SearchSummary> {
    this.cancel(searchId);
    const token = { cancelled: false };
    this.tokens.set(searchId, token);
    let scanned = 0;
    let matched = 0;
    try {
      if (!query.trim()) return { scanned, matched, cancelled: false };
      for (const path of paths) {
        if (token.cancelled) break;
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        scanned++;
        const payload = await readMarkdown(path).catch(() => null);
        if (token.cancelled) break;
        const match = payload && firstMatch(payload.content, query, caseSensitive);
        if (match) { matched++; emit({ kind: "content", path, ...match, scanned, matched }); }
        if (scanned % 25 === 0) emit({ kind: "progress", path: "", line: null, snippet: null, scanned, matched });
      }
      return { scanned, matched, cancelled: token.cancelled };
    } finally {
      if (this.tokens.get(searchId) === token) this.tokens.delete(searchId);
    }
  }
}
