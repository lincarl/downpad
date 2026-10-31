// The platform steps of an update: recognizing how this copy was installed and
// putting a verified release package in its place. main.ts decides when to run
// each step and restarts Downpad afterwards.

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, chmod, constants, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { isMsiInstallation, linuxPackageKind, type PackageKind } from "./updatePlan";

export const INTEGRITY_FAILURE = "The downloaded update failed its integrity check and was discarded.";

/** Copy `source` to the new file `destination`, hashing exactly the bytes it
 *  writes. A copy whose SHA-256 digest is not `sha256` is removed, so only
 *  verified bytes reach an installer, even if the source changes meanwhile. An
 *  existing `destination` is refused and left as it is. */
export async function copyVerified(source: string, destination: string, sha256: string, mode = 0o644): Promise<void> {
  const output = await open(destination, "wx", mode);
  const hash = createHash("sha256");
  try {
    await pipeline(
      createReadStream(source),
      new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } }),
      output.createWriteStream(),
    );
    if (hash.digest("hex") !== sha256) throw new Error(INTEGRITY_FAILURE);
  } catch (error) {
    await output.close().catch(() => {});
    await rm(destination, { force: true });
    throw error;
  }
}

/** Replace the AppImage at `target` with the verified package `file`. The copy
 *  goes beside the target first, so the final rename stays on one filesystem:
 *  a crash leaves the old image or the new one, never half of one. The running
 *  process keeps the image it already mounted. */
export async function replaceAppImage(file: string, sha256: string, target: string): Promise<void> {
  const staged = `${target}.update-${randomUUID()}`;
  try {
    await copyVerified(file, staged, sha256, 0o755);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

const SYSTEM_PROGRAM_FOLDERS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The command, program first, that installs a DEB package through pkexec, to
 *  which the package's path is added, or null without pkexec or a package
 *  manager. apt-get also installs dependencies that a new version adds. */
export function debInstallCommand(exists: (path: string) => boolean = existsSync): string[] | null {
  const find = (name: string): string | undefined => SYSTEM_PROGRAM_FOLDERS.map((folder) => posix.join(folder, name)).find(exists);
  const pkexec = find("pkexec");
  if (!pkexec) return null;
  const apt = find("apt-get");
  if (apt) return [pkexec, apt, "install", "-y"];
  const dpkg = find("dpkg");
  return dpkg ? [pkexec, dpkg, "-i"] : null;
}

/** pkexec's exit codes when the user dismissed or failed its authentication. */
const AUTHORIZATION_REFUSED = new Set([126, 127]);

/** Install the verified DEB package `file` with `command` from
 *  debInstallCommand. pkexec asks for the password in its own window. Returns
 *  "cancelled" when the user dismissed that, and throws when the package
 *  manager fails. */
export async function installDeb(file: string, sha256: string, command: readonly string[]): Promise<"installed" | "cancelled"> {
  const staging = await mkdtemp(join(tmpdir(), "downpad-update-"));
  try {
    // apt-get reads the package as its own unprivileged user.
    await chmod(staging, 0o755);
    const staged = join(staging, basename(file));
    await copyVerified(file, staged, sha256, 0o644);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command[0]!, [...command.slice(1), staged], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code === 0) return "installed";
    if (code !== null && AUTHORIZATION_REFUSED.has(code)) return "cancelled";
    throw new Error(`The package manager stopped with exit code ${code ?? "unknown"}.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface MsiHelperPaths {
  /** Windows' System32 folder. */
  system: string;
  /** Windows Installer, System32's msiexec.exe unless a test supplies another. */
  msiexec?: string;
  /** The verified MSI, alone in `staging`. */
  package: string;
  staging: string;
  /** Downpad's executable, which starts again after the installation. */
  executable: string;
  /** Receives the installer's exit code, which the next start reads. */
  result: string;
  /** A file to open after the restart. */
  argument?: string;
}

/** The detached helper that waits for Downpad to exit, runs the MSI
 *  installation, writes its exit code to `result`, removes the package and its
 *  folder, and starts Downpad again, also after a failed or cancelled
 *  installation. It waits with `set /p`, which reads its standard input, a pipe
 *  from Downpad, until the pipe closes as Downpad's process ends, so the running
 *  copy never holds the files that the installer replaces. The paths reach cmd
 *  only as variables that it expands once, with delayed expansion off, so their
 *  characters are never parsed as commands. A path with a quote or a line break
 *  is refused. The exit code is read through `call`, which expands
 *  `%ERRORLEVEL%` when it runs; the caret keeps the first expansion of the whole
 *  line from reading it before the installer has run. */
export function msiHelper(paths: MsiHelperPaths): { file: string; args: [string]; env: Record<string, string> } {
  for (const value of Object.values(paths)) {
    if (value !== undefined && /["\r\n\0]/.test(value)) throw new Error("An update path contains a character that Windows paths cannot contain.");
  }
  const env: Record<string, string> = {
    DOWNPAD_UPDATE_MSIEXEC: paths.msiexec ?? win32.join(paths.system, "msiexec.exe"),
    DOWNPAD_UPDATE_PACKAGE: paths.package,
    DOWNPAD_UPDATE_STAGING: paths.staging,
    DOWNPAD_UPDATE_SYSTEM: paths.system,
    DOWNPAD_UPDATE_EXECUTABLE: paths.executable,
    DOWNPAD_UPDATE_RESULT: paths.result,
  };
  if (paths.argument) env.DOWNPAD_UPDATE_ARGUMENT = paths.argument;
  const command = '/d /v:off /s /c "set /p DOWNPAD_UPDATE_WAIT=' +
    ' & start "" /wait "%DOWNPAD_UPDATE_MSIEXEC%" /i "%DOWNPAD_UPDATE_PACKAGE%" /passive /norestart' +
    ' & >"%DOWNPAD_UPDATE_RESULT%" call echo %^ERRORLEVEL%' +
    ' & del /q "%DOWNPAD_UPDATE_PACKAGE%" & cd /d "%DOWNPAD_UPDATE_SYSTEM%" & rd "%DOWNPAD_UPDATE_STAGING%"' +
    ` & start "" "%DOWNPAD_UPDATE_EXECUTABLE%"${paths.argument ? ' "%DOWNPAD_UPDATE_ARGUMENT%"' : ""}"`;
  return { file: win32.join(paths.system, "cmd.exe"), args: [command], env };
}

/** Windows' System32 folder, named directly so that no program is looked up in
 *  the current folder, which can be the folder of the file Downpad opened. */
function systemFolder(): string {
  return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
}

/** A verified copy of an MSI, alone in a new private folder. */
export interface StagedMsi {
  package: string;
  staging: string;
}

/** Copy the downloaded MSI `file` into a new private folder and verify the
 *  copy, so the download can be forgotten before the installation starts. */
export async function stageMsi(file: string, sha256: string): Promise<StagedMsi> {
  const staging = await mkdtemp(join(tmpdir(), "downpad-update-"));
  const staged = join(staging, basename(file));
  try {
    await copyVerified(file, staged, sha256);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { package: staged, staging };
}

/** Remove a staged MSI that will not be installed. */
export async function discardStagedMsi(staged: StagedMsi): Promise<void> {
  await rm(staged.staging, { recursive: true, force: true }).catch(() => {});
}

/** Start the installation of `staged` in a detached helper (msiHelper), which
 *  writes the installer's exit code to `result`. The helper starts the
 *  installer once the returned pipe closes, which happens when this process
 *  ends, so the caller must quit at once. Tests close the pipe instead. If the
 *  helper cannot start or its PID cannot be saved, the staged copy is removed.
 *  `msiexec` replaces Windows Installer in tests. `onStarted` saves the helper's
 *  PID before the caller can exit and release its pipe. */
export async function startMsiInstaller(staged: StagedMsi, executable: string, result: string, argument?: string,
  options: { msiexec?: string; onStarted?: (pid: number) => Promise<void> } = {}): Promise<Writable> {
  try {
    const helper = msiHelper({ system: systemFolder(), msiexec: options.msiexec, package: staged.package, staging: staged.staging, executable, result, argument });
    return await new Promise<Writable>((resolve, reject) => {
      const child = spawn(helper.file, helper.args, {
        cwd: staged.staging, env: { ...process.env, ...helper.env }, detached: true, stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true, windowsVerbatimArguments: true,
      });
      child.once("error", reject);
      // Nothing is written to the pipe, so a helper that ends first cannot
      // make it fail, but an error event without a listener would throw.
      child.stdin!.on("error", () => {});
      child.once("spawn", () => {
        void Promise.resolve().then(() => options.onStarted?.(child.pid!)).then(() => {
          child.unref();
          resolve(child.stdin!);
        }, (error: unknown) => {
          // Keep the pipe open until the helper exits, so it cannot run the MSI
          // after the caller fails to persist its ownership of the update.
          child.once("exit", () => { child.stdin!.destroy(); reject(error); });
          if (!child.kill()) { child.stdin!.destroy(); reject(error); }
        });
      });
    });
  } catch (error) {
    await rm(staged.staging, { recursive: true, force: true });
    throw error;
  }
}

const executeFile = promisify(execFile);

/** A string value from a registry export, which reg.exe writes in UTF-16 with
 *  backslashes and quotes escaped, or empty without one. */
export function exportedRegistryString(exported: Buffer, name: string): string {
  const text = exported.toString("utf16le").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const match = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (match && match[1]!.replace(/\\(.)/g, "$1") === name) return match[2]!.replace(/\\(.)/g, "$1");
  }
  return "";
}

/** The installation folder that the MSI recorded in `key`, or empty. reg.exe's
 *  query prints in the console's code page, which can garble a folder name
 *  such as one under C:\\Users\\Jörg, so the value comes from an export instead. */
export async function registeredMsiFolder(key = "HKCU\\Software\\Downpad"): Promise<string> {
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "downpad-registry-"));
    const file = join(folder, "key.reg");
    await executeFile(win32.join(systemFolder(), "reg.exe"), ["export", key, file, "/y"], { timeout: 5000, windowsHide: true });
    return exportedRegistryString(await readFile(file), "InstallDir");
  } catch { return ""; } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** The files of the installed `downpad` DEB package, from dpkg's database. */
async function debPackageFiles(): Promise<string[] | null> {
  return readFile("/var/lib/dpkg/info/downpad.list", "utf8").then((text) => text.split("\n"), () => null);
}

/** How this running copy was installed, if it can install updates itself.
 *  Only packaged release versions do, from the x64 MSI, AppImage or DEB of a
 *  release. An AppImage needs a writable folder and a DEB needs pkexec and a
 *  package manager. Builds without a release version (0.0.0) never update. */
export async function installedPackageKind(app: { isPackaged: boolean; version: string }): Promise<PackageKind | null> {
  if (!app.isPackaged || app.version === "0.0.0" || process.arch !== "x64") return null;
  if (process.platform === "win32") {
    return isMsiInstallation(process.execPath, await registeredMsiFolder()) ? "msi" : null;
  }
  if (process.platform !== "linux") return null;
  const appImage = process.env.APPIMAGE;
  const appImageFile = appImage && (await stat(appImage).then((info) => info.isFile(), () => false)) ? appImage : undefined;
  const kind = linuxPackageKind(process.execPath, appImageFile, process.env.APPDIR, await debPackageFiles());
  if (kind === "appimage") return access(dirname(appImageFile!), constants.W_OK).then(() => kind, () => null);
  if (kind === "deb") return debInstallCommand() ? kind : null;
  return null;
}
