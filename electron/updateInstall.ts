// The platform steps of an update: recognizing how this copy was installed and
// putting a verified release package in its place. main.ts decides when to run
// each step and restarts Downpad afterwards.

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, chmod, constants, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { isMsiInstallation, linuxPackageKind, type PackageKind } from "./updatePlan";

export const INTEGRITY_FAILURE = "The downloaded update failed its integrity check and was discarded.";

/** Copy `source` to the new file `destination`, hashing exactly the bytes it
 *  writes. A copy whose SHA-256 digest is not `sha256` is removed, so only
 *  verified bytes reach an installer, even if the source changes meanwhile. */
export async function copyVerified(source: string, destination: string, sha256: string, mode = 0o644): Promise<void> {
  const hash = createHash("sha256");
  try {
    await pipeline(
      createReadStream(source),
      new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } }),
      createWriteStream(destination, { flags: "wx", mode }),
    );
    if (hash.digest("hex") !== sha256) throw new Error(INTEGRITY_FAILURE);
  } catch (error) {
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
  const find = (name: string): string | undefined => SYSTEM_PROGRAM_FOLDERS.map((folder) => join(folder, name)).find(exists);
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
  /** A file to open after the restart. */
  argument?: string;
}

/** The detached helper that waits for the MSI installation, removes the
 *  package and its folder, and starts Downpad again, also after a failed or
 *  cancelled installation. The paths reach cmd only as variables that it
 *  expands once, with delayed expansion off, so their characters are never
 *  parsed as commands. A path with a quote or a line break is refused. */
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
  };
  if (paths.argument) env.DOWNPAD_UPDATE_ARGUMENT = paths.argument;
  const command = '/d /v:off /s /c "start "" /wait "%DOWNPAD_UPDATE_MSIEXEC%" /i "%DOWNPAD_UPDATE_PACKAGE%" /passive /norestart' +
    ' & del /q "%DOWNPAD_UPDATE_PACKAGE%" & cd /d "%DOWNPAD_UPDATE_SYSTEM%" & rd "%DOWNPAD_UPDATE_STAGING%"' +
    ` & start "" "%DOWNPAD_UPDATE_EXECUTABLE%"${paths.argument ? ' "%DOWNPAD_UPDATE_ARGUMENT%"' : ""}"`;
  return { file: win32.join(paths.system, "cmd.exe"), args: [command], env };
}

/** Windows' System32 folder, named directly so that no program is looked up in
 *  the current folder, which can be the folder of the file Downpad opened. */
function systemFolder(): string {
  return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
}

/** Start the MSI installation of the verified package `file` in a detached
 *  helper (msiHelper). The caller must quit at once, so the installer can
 *  replace Downpad's files. `msiexec` replaces Windows Installer in tests. */
export async function startMsiInstaller(file: string, sha256: string, executable: string, argument?: string, msiexec?: string): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "downpad-update-"));
  try {
    const staged = join(staging, basename(file));
    await copyVerified(file, staged, sha256);
    const helper = msiHelper({ system: systemFolder(), msiexec, package: staged, staging, executable, argument });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(helper.file, helper.args, {
        cwd: staging, env: { ...process.env, ...helper.env }, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const executeFile = promisify(execFile);

/** The installation folder that the MSI registered for this user, or empty. */
async function registeredMsiFolder(): Promise<string> {
  try {
    const { stdout } = await executeFile(win32.join(systemFolder(), "reg.exe"), ["query", "HKCU\\Software\\Downpad", "/v", "InstallDir"],
      { timeout: 5000, windowsHide: true });
    return /\sInstallDir\s+REG_SZ\s+([^\r\n]+)/.exec(stdout)?.[1]?.trim() ?? "";
  } catch { return ""; }
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
