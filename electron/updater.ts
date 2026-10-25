import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateInfo, UpdateState } from "../src/ipc/contracts";
import { writeAtomic } from "./io";
import {
  allowedUrl, assetFor, assetName, checkDue, isNewerStable, isSha256, parseRelease, RELEASE_API_URL,
  type PackageKind, type ReleaseAsset,
} from "./updatePlan";

/** A verified download that installs on a later start. */
export interface PendingUpdate {
  version: string;
  /** The absolute path of the downloaded package. */
  file: string;
  sha256: string;
}

interface StoredPending {
  version: string;
  /** The package's file name in this kind's folder. */
  file: string;
  sha256: string;
  /** Downloaded by Check for updates or chosen with Restart now, so it installs
   *  even with automatic updates off. */
  approved: boolean;
}

interface StoredState {
  lastCheckMs?: number;
  pending?: StoredPending;
  /** The version handed to the Windows installer, which the next start checks. */
  installing?: string;
}

/** What the start found: the download to install now, and why the update that
 *  the Windows installer ran before failed, if it did. */
export interface StartState {
  pending: PendingUpdate | null;
  failure: string | null;
}

export interface UpdaterOptions {
  /** This copy's version, such as `1.2.3` or `1.2.3-rc1`. */
  version: string;
  /** How this copy was installed, or null when it cannot update itself. */
  kind: PackageKind | null;
  /** The folder for update state and downloads, with one folder per kind, so
   *  copies of different kinds never install or delete each other's packages. */
  directory: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Replaces GitHub's release API for tests, which may then serve over HTTP
   *  from this computer. */
  apiUrl?: string;
  now?: () => number;
  onChange?: (info: UpdateInfo) => void;
}

/** GitHub refuses API requests without a user agent. */
const USER_AGENT = "Downpad updater";
const REQUEST_TIMEOUT_MS = 30_000;
/** A download that receives nothing for this long is abandoned. */
const STALL_TIMEOUT_MS = 60_000;
/** No release package comes near this size; a larger answer is not one. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const STATE_FILE = "state.json";
/** The Windows installer's exit code, which the update helper writes. */
const RESULT_FILE = "install-result.txt";
/** Windows Installer's exit codes for a completed installation, also one that
 *  waits for a restart of Windows. */
const MSI_SUCCESS = new Set([0, 1641, 3010]);
/** Windows Installer's exit code when the user cancelled. */
const MSI_CANCELLED = 1602;

/** Reads GitHub's latest release, downloads the package that matches how this
 *  copy was installed, verifies its SHA-256 digest from the release API and
 *  keeps it for the next start, which installs it (main.ts). Automatic checks
 *  run on a start at least 30 days after the last successful check.
 *  Copies that cannot install updates themselves only report a newer release. */
export class Updater {
  private state: UpdateState = { status: "idle" };
  private lastCheckMs: number | null = null;
  private running: Promise<void> | null = null;
  /** Whether Settings follows the running check, which then reports failures
   *  and marks its download as asked for. */
  private manual = false;
  private readonly apiUrl: string;
  private readonly allowLoopbackHttp: boolean;
  private readonly now: () => number;

  constructor(private readonly options: UpdaterOptions) {
    this.apiUrl = options.apiUrl ?? RELEASE_API_URL;
    this.allowLoopbackHttp = options.apiUrl !== undefined;
    if (!allowedUrl(this.apiUrl, this.allowLoopbackHttp)) throw new Error("The update address must use HTTPS, or HTTP on this computer.");
    this.now = options.now ?? Date.now;
  }

  /** What Settings shows about updates. */
  info(): UpdateInfo {
    return { version: this.options.version, selfUpdate: this.options.kind !== null, lastCheckMs: this.lastCheckMs, state: this.state };
  }

  /** Read the saved state at start and delete downloads this copy no longer
   *  needs, such as the package of the update that was just installed. Returns
   *  the verified download to install now, which needs automatic updates on or
   *  a download the user asked for. With automatic updates off, an automatic
   *  download is deleted instead. Also reports an update that the Windows
   *  installer did not complete. */
  async start(autoUpdate: boolean): Promise<StartState> {
    const kind = this.options.kind;
    if (!kind) return { pending: null, failure: null };
    const saved = await this.readState();
    this.lastCheckMs = typeof saved.lastCheckMs === "number" && Number.isFinite(saved.lastCheckMs) ? saved.lastCheckMs : null;
    const failure = saved.installing ? await this.installerFailure(saved.installing, kind) : null;
    let pending = saved.pending ?? null;
    if (pending && !(await this.usable(pending, kind))) pending = null;
    if (pending && !autoUpdate && !pending.approved) pending = null;
    if (pending !== (saved.pending ?? null) || saved.installing) {
      await this.writeState({ lastCheckMs: saved.lastCheckMs, pending: pending ?? undefined });
    }
    await this.tidy(pending?.file);
    if (failure) this.state = { status: "failed", message: failure };
    this.notify();
    return {
      pending: pending ? { version: pending.version, file: join(this.folder(kind), pending.file), sha256: pending.sha256 } : null,
      failure,
    };
  }

  /** Why the Windows installer did not install `version`, from the exit code
   *  that the update helper wrote, or null when this copy runs that version or
   *  the user cancelled. */
  private async installerFailure(version: string, kind: PackageKind): Promise<string | null> {
    const code = await readFile(join(this.folder(kind), RESULT_FILE), "utf8").then((text) => Number.parseInt(text.trim(), 10), () => Number.NaN);
    if (!isNewerStable(version, this.options.version) || code === MSI_CANCELLED) return null;
    const detail = Number.isNaN(code) ? "The Windows installer did not finish."
      : MSI_SUCCESS.has(code) ? "The Windows installer finished, but Downpad was not replaced."
      : `The Windows installer stopped with error ${code}.`;
    return `Couldn't install Downpad ${version}. ${detail}`;
  }

  /** Where the Windows update helper writes the installer's exit code. */
  installerResultFile(): string {
    return join(this.folder(this.options.kind ?? "msi"), RESULT_FILE);
  }

  /** The start handed the verified, already staged download of `version` to
   *  the Windows installer: forget the download, record the version for the
   *  next start, and wait for the next due check. The helper starts Downpad
   *  again also after a failed or cancelled installation, so without this every
   *  start would try again. */
  async handedToInstaller(version: string): Promise<void> {
    const kind = this.options.kind;
    if (!kind) return;
    this.lastCheckMs = this.now();
    await this.writeState({ lastCheckMs: this.lastCheckMs, installing: version });
    await this.tidy();
  }

  /** Check in the background when automatic updates are on and a check is due. */
  checkIfDue(autoUpdate: boolean): Promise<void> {
    if (!autoUpdate || !this.options.kind || !checkDue(this.lastCheckMs, this.now())) return Promise.resolve();
    return this.run(false);
  }

  /** Check now on behalf of Settings, reporting progress and failures. While an
   *  automatic check runs, Settings follows that one instead, which then reports
   *  as a manual check does, and a download it made counts as asked for. */
  async checkNow(): Promise<void> {
    if (this.running) {
      this.manual = true;
      if (this.state.status !== "downloading") this.setState({ status: "checking" });
      await this.running;
      if (this.state.status === "ready") await this.approve().catch(() => false);
      // An automatic check that failed before Settings joined it said nothing.
      if (this.state.status !== "checking") return;
    }
    return this.run(true);
  }

  /** Mark the waiting download as chosen by the user, so the next start
   *  installs it also with automatic updates off. False when none waits. */
  async approve(): Promise<boolean> {
    const kind = this.options.kind;
    if (!kind) return false;
    const saved = await this.readState();
    if (!saved.pending || !(await this.usable(saved.pending, kind))) return false;
    await this.writeState({ ...saved, pending: { ...saved.pending, approved: true } });
    return true;
  }

  /** Automatic updates were switched off: delete a download that only they
   *  would install. A download the user asked for stays. */
  async automaticUpdatesOff(): Promise<void> {
    const kind = this.options.kind;
    if (!kind) return;
    await this.running?.catch(() => {});
    const saved = await this.readState();
    if (!saved.pending || saved.pending.approved) return;
    await this.writeState({ ...saved, pending: undefined });
    await this.tidy();
    if (this.state.status === "ready") this.setState({ status: "idle" });
  }

  /** Forget the waiting download after this start tried to install it, or
   *  handed it to the Windows installer, and wait for the next due check. An
   *  installation that fails, or that the user cancels, then never repeats on
   *  every start. Check for updates downloads it again. `message` reports a
   *  failure in Settings. */
  async dropPending(message?: string): Promise<void> {
    const kind = this.options.kind;
    if (!kind) return;
    this.lastCheckMs = this.now();
    await this.writeState({ lastCheckMs: this.lastCheckMs });
    await this.tidy();
    this.setState(message ? { status: "failed", message } : { status: "idle" });
  }

  /** Run one check, which never rejects: an unexpected failure, such as a
   *  state file that cannot be written, ends it as a failed check, so Settings
   *  never waits on it. */
  private run(manual: boolean): Promise<void> {
    if (this.running) return this.running;
    this.manual = manual;
    this.running = this.check().catch((error: unknown) => {
      if (this.manual) this.setState({ status: "failed", message: `Couldn't check for updates. ${reason(error)}` });
      else this.settle();
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async check(): Promise<void> {
    if (this.manual) this.setState({ status: "checking" });
    let text: string;
    try {
      const response = await this.options.fetch(this.apiUrl, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`The update server answered with HTTP ${response.status}.`);
      text = await response.text();
    } catch (error) {
      // A failed check stays due, so the next start tries again.
      if (this.manual) this.setState({ status: "failed", message: `Couldn't check for updates. ${reason(error)}` });
      else this.settle();
      return;
    }
    const { understood, release } = parseRelease(text);
    if (!understood) {
      if (this.manual) this.setState({ status: "failed", message: "Couldn't check for updates. The update server's answer couldn't be read." });
      else this.settle();
      return;
    }
    if (!release || !isNewerStable(release.version, this.options.version)) {
      await this.markChecked();
      if (this.manual) this.setState({ status: "up-to-date" });
      else this.notify();
      return;
    }
    const kind = this.options.kind;
    const asset = kind ? assetFor(release, kind, this.allowLoopbackHttp) : null;
    if (!kind || !asset) {
      await this.markChecked();
      this.setState({ status: "available", version: release.version, pageUrl: release.pageUrl });
      return;
    }
    const saved = await this.readState();
    if (saved.pending?.version === release.version && saved.pending.sha256 === asset.sha256 && (await this.usable(saved.pending, kind))) {
      if (this.manual && !saved.pending.approved) await this.writeState({ ...saved, pending: { ...saved.pending, approved: true } });
      await this.markChecked();
      this.setState({ status: "ready", version: release.version });
      return;
    }
    await this.download(kind, asset, release.version);
  }

  /** Stream `asset` into this kind's folder while hashing it, and keep it as the
   *  pending update once its digest matches the release API's. */
  private async download(kind: PackageKind, asset: ReleaseAsset, version: string): Promise<void> {
    const folder = this.folder(kind);
    const part = join(folder, `${asset.name}.part`);
    this.setState({ status: "downloading", version, percent: 0 });
    const controller = new AbortController();
    let stall: NodeJS.Timeout | undefined;
    const watch = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error("The download stopped responding.")), STALL_TIMEOUT_MS);
    };
    try {
      await mkdir(folder, { recursive: true });
      watch();
      const response = await this.options.fetch(asset.url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`The download server answered with HTTP ${response.status}.`);
      const total = Number(response.headers.get("content-length")) || null;
      if (total !== null && total > MAX_DOWNLOAD_BYTES) throw new Error("The download is larger than any Downpad package.");
      const hash = createHash("sha256");
      let received = 0;
      let reported = -1;
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          watch();
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) return done(new Error("The download is larger than any Downpad package."));
          hash.update(chunk);
          const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
          if (percent !== reported) {
            reported = percent ?? -1;
            this.setState({ status: "downloading", version, percent });
          }
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), progress,
        createWriteStream(part), { signal: controller.signal });
      if (hash.digest("hex") !== asset.sha256) {
        throw new Error("The downloaded update failed its integrity check and was discarded.");
      }
      await rename(part, join(folder, asset.name));
      this.lastCheckMs = this.now();
      await this.writeState({ lastCheckMs: this.lastCheckMs, pending: { version, file: asset.name, sha256: asset.sha256, approved: this.manual } });
      await this.tidy(asset.name);
      this.setState({ status: "ready", version });
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      if (this.manual) this.setState({ status: "failed", message: `Couldn't download Downpad ${version}. ${reason(error)}` });
      else this.settle();
    } finally {
      clearTimeout(stall);
    }
  }

  private folder(kind: PackageKind): string {
    return join(this.options.directory, kind);
  }

  /** Whether a saved pending update is still newer than this copy, is named as
   *  the release names this kind's package, and its file is there. */
  private async usable(pending: StoredPending, kind: PackageKind): Promise<boolean> {
    if (typeof pending.version !== "string" || typeof pending.file !== "string" || typeof pending.sha256 !== "string") return false;
    if (!isNewerStable(pending.version, this.options.version) || !isSha256(pending.sha256) || pending.file !== assetName(kind, pending.version)) return false;
    return stat(join(this.folder(kind), pending.file)).then((info) => info.isFile(), () => false);
  }

  /** Delete everything in this kind's folder but its state and `keep`, such as
   *  a package already installed or an unfinished download. */
  private async tidy(keep?: string): Promise<void> {
    const kind = this.options.kind;
    if (!kind) return;
    const names = await readdir(this.folder(kind)).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => name !== STATE_FILE && name !== keep)
      .map((name) => rm(join(this.folder(kind), name), { recursive: true, force: true }).catch(() => {})));
  }

  private async markChecked(): Promise<void> {
    this.lastCheckMs = this.now();
    if (!this.options.kind) return;
    const saved = await this.readState();
    await this.writeState({ ...saved, lastCheckMs: this.lastCheckMs });
  }

  private async readState(): Promise<StoredState> {
    const kind = this.options.kind;
    if (!kind) return {};
    try {
      const value: unknown = JSON.parse(await readFile(join(this.folder(kind), STATE_FILE), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const source = value as Record<string, unknown>;
      const pending = source.pending;
      return {
        lastCheckMs: typeof source.lastCheckMs === "number" ? source.lastCheckMs : undefined,
        pending: pending && typeof pending === "object" && !Array.isArray(pending)
          ? { ...(pending as StoredPending), approved: (pending as Record<string, unknown>).approved === true }
          : undefined,
        installing: typeof source.installing === "string" ? source.installing : undefined,
      };
    } catch { return {}; }
  }

  private async writeState(state: StoredState): Promise<void> {
    const kind = this.options.kind;
    if (!kind) return;
    await mkdir(this.folder(kind), { recursive: true });
    await writeAtomic(join(this.folder(kind), STATE_FILE), JSON.stringify(state));
  }

  /** End an automatic check or download that failed without a word, since
   *  nobody asked for it. A failed check stays due for the next start. */
  private settle(): void {
    if (this.state.status !== "idle") this.setState({ status: "idle" });
  }

  private setState(state: UpdateState): void {
    this.state = state;
    this.notify();
  }

  private notify(): void {
    this.options.onChange?.(this.info());
  }
}

/** The message of a failure, for a sentence after "Couldn't …". */
function reason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "The update server didn't answer in time.";
  const message = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}
