import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  copyVerified, debInstallCommand, exportedRegistryString, INTEGRITY_FAILURE, installDeb, msiHelper, registeredMsiFolder, replaceAppImage,
  stageMsi, startMsiInstaller,
} from "./updateInstall";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const PACKAGE = Buffer.from("new package bytes");
const DIGEST = createHash("sha256").update(PACKAGE).digest("hex");
const OTHER = "0".repeat(64);

async function folder(name = "run-"): Promise<string> {
  const root = resolve("dev-temp", "update-install-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, name));
  directories.push(directory);
  return directory;
}

async function download(directory: string, name = "Downpad-1.3.0-linux-x86_64.AppImage"): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, PACKAGE);
  return file;
}

describe("Verified copies", () => {
  it("copies a package whose digest matches", async () => {
    const directory = await folder();
    const source = await download(directory);
    await copyVerified(source, join(directory, "copy"), DIGEST);
    expect(await readFile(join(directory, "copy"))).toEqual(PACKAGE);
  });

  it("removes a copy whose digest differs and never overwrites an existing file", async () => {
    const directory = await folder();
    const source = await download(directory);
    await expect(copyVerified(source, join(directory, "copy"), OTHER)).rejects.toThrow(INTEGRITY_FAILURE);
    expect(await readdir(directory)).toEqual(["Downpad-1.3.0-linux-x86_64.AppImage"]);
    await writeFile(join(directory, "taken"), "keep");
    await expect(copyVerified(source, join(directory, "taken"), DIGEST)).rejects.toThrow(/EEXIST/);
    expect(await readFile(join(directory, "taken"), "utf8")).toBe("keep");
  });
});

describe.skipIf(process.platform === "win32")("AppImage updates", () => {
  it("replaces the running image with an executable copy of the new one", async () => {
    const directory = await folder();
    const target = join(directory, "Downpad.AppImage");
    await writeFile(target, "old image", { mode: 0o700 });
    await replaceAppImage(await download(directory), DIGEST, target);
    expect(await readFile(target)).toEqual(PACKAGE);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect((await readdir(directory)).sort()).toEqual(["Downpad-1.3.0-linux-x86_64.AppImage", "Downpad.AppImage"]);
  });

  it("leaves the running image alone when the download no longer matches", async () => {
    const directory = await folder();
    const target = join(directory, "Downpad.AppImage");
    await writeFile(target, "old image");
    await expect(replaceAppImage(await download(directory), OTHER, target)).rejects.toThrow(INTEGRITY_FAILURE);
    expect(await readFile(target, "utf8")).toBe("old image");
    expect((await readdir(directory)).sort()).toEqual(["Downpad-1.3.0-linux-x86_64.AppImage", "Downpad.AppImage"]);
  });
});

describe("DEB updates", () => {
  it("installs through pkexec with apt-get, or dpkg without it", () => {
    const present = (...paths: string[]) => (path: string) => paths.includes(path);
    expect(debInstallCommand(present("/usr/bin/pkexec", "/usr/bin/apt-get", "/usr/bin/dpkg"))).toEqual(["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y"]);
    expect(debInstallCommand(present("/usr/bin/pkexec", "/usr/bin/dpkg"))).toEqual(["/usr/bin/pkexec", "/usr/bin/dpkg", "-i"]);
    expect(debInstallCommand(present("/usr/bin/apt-get", "/usr/bin/dpkg"))).toBeNull();
    expect(debInstallCommand(present("/usr/bin/pkexec"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("passes a readable verified copy to the package manager and removes it afterwards", async () => {
    const directory = await folder();
    const record = join(directory, "installed");
    const file = await download(directory, "Downpad-1.3.0-linux-amd64.deb");
    // The fake package manager records the package it got and whether others can read it.
    const command = ["/bin/sh", "-c", `cat "$1" > "${record}" && stat -c %a "$1" >> "${record}" && stat -c %a "$(dirname "$1")" >> "${record}"`, "sh"];
    expect(await installDeb(file, DIGEST, command)).toBe("installed");
    expect(await readFile(record, "utf8")).toBe(`${PACKAGE.toString()}644\n755\n`);
  });

  it.skipIf(process.platform === "win32")("reports a dismissed password prompt as cancelled and a failure as an error", async () => {
    const directory = await folder();
    const file = await download(directory, "Downpad-1.3.0-linux-amd64.deb");
    expect(await installDeb(file, DIGEST, ["/bin/sh", "-c", "exit 126", "sh"])).toBe("cancelled");
    await expect(installDeb(file, DIGEST, ["/bin/sh", "-c", "exit 100", "sh"])).rejects.toThrow("The package manager stopped with exit code 100.");
    await expect(installDeb(file, OTHER, ["/bin/sh", "-c", "exit 0", "sh"])).rejects.toThrow(INTEGRITY_FAILURE);
  });
});

describe("MSI updates", () => {
  const paths = {
    system: "C:\\Windows\\System32",
    package: "C:\\Users\\a\\AppData\\Local\\Temp\\downpad-update-x\\Downpad-1.3.0-win-x64.msi",
    staging: "C:\\Users\\a\\AppData\\Local\\Temp\\downpad-update-x",
    executable: "C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\Downpad.exe",
    result: "C:\\Users\\a\\AppData\\Roaming\\Downpad\\updates\\msi\\install-result.txt",
  };

  it("passes every path to cmd as a variable, never in the command itself", () => {
    const helper = msiHelper({ ...paths, argument: "D:\\Notes & 100% ^done!\\plan (1).md" });
    expect(helper.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(helper.env).toEqual({
      DOWNPAD_UPDATE_MSIEXEC: "C:\\Windows\\System32\\msiexec.exe",
      DOWNPAD_UPDATE_PACKAGE: paths.package,
      DOWNPAD_UPDATE_STAGING: paths.staging,
      DOWNPAD_UPDATE_SYSTEM: paths.system,
      DOWNPAD_UPDATE_EXECUTABLE: paths.executable,
      DOWNPAD_UPDATE_RESULT: paths.result,
      DOWNPAD_UPDATE_ARGUMENT: "D:\\Notes & 100% ^done!\\plan (1).md",
    });
    expect(helper.args[0]).toBe('/d /v:off /s /c "start "" /wait "%DOWNPAD_UPDATE_MSIEXEC%" /i "%DOWNPAD_UPDATE_PACKAGE%" /passive /norestart' +
      ' & >"%DOWNPAD_UPDATE_RESULT%" call echo %^ERRORLEVEL%' +
      ' & del /q "%DOWNPAD_UPDATE_PACKAGE%" & cd /d "%DOWNPAD_UPDATE_SYSTEM%" & rd "%DOWNPAD_UPDATE_STAGING%"' +
      ' & start "" "%DOWNPAD_UPDATE_EXECUTABLE%" "%DOWNPAD_UPDATE_ARGUMENT%""');
    expect(msiHelper(paths).args[0]).toMatch(/ & start "" "%DOWNPAD_UPDATE_EXECUTABLE%""$/);
  });

  it("refuses a path that cmd could read as more than a path", () => {
    expect(() => msiHelper({ ...paths, argument: 'D:\\a" & calc & "' })).toThrow(/cannot contain/);
    expect(() => msiHelper({ ...paths, executable: "C:\\a\r\nb.exe" })).toThrow(/cannot contain/);
  });

  // Runs the real helper with stand-ins for Windows Installer and Downpad,
  // in folders whose names cmd would otherwise misread. START runs a batch
  // file in cmd /k, so each stand-in ends with exit.
  it.runIf(process.platform === "win32")("installs, records the exit code, removes the copy and starts Downpad again with its file", { timeout: 60_000 }, async () => {
    const directory = await folder("Downpad & 100% ^test! (1) ");
    // The stand-ins are batch files, which read % in their own text, so their
    // record goes to a plainly named folder.
    const plain = await folder();
    const record = join(plain, "record.txt");
    const result = join(directory, "install-result.txt");
    const msiexec = join(directory, "fake msiexec.cmd");
    const executable = join(directory, "fake Downpad.cmd");
    await writeFile(msiexec, `@echo installer %*>> "${record}"\r\n@exit 1618\r\n`);
    await writeFile(executable, `@echo started %*>> "${record}"\r\n@exit\r\n`);
    const file = await download(directory, "Downpad-1.3.0-win-x64.msi");
    const staged = await stageMsi(file, DIGEST);
    await startMsiInstaller(staged, executable, result, join(directory, "notes & 50%.md"), msiexec);
    // Each stand-in opens a console window, which can take seconds on CI.
    let text = "";
    let code = "";
    for (let waited = 0; waited < 40_000 && !(text.includes("started") && code); waited += 250) {
      await new Promise((done) => setTimeout(done, 250));
      text = await readFile(record, "utf8").catch(() => "");
      code = await readFile(result, "utf8").catch(() => "");
    }
    if (!text.includes("started") || !code) {
      throw new Error(`The helper did not finish. Record: ${JSON.stringify(text)}. Result: ${JSON.stringify(code)}. ` +
        `Staging left: ${await stat(staged.staging).then(() => true, () => false)}.`);
    }
    const [installer, started] = text.trim().split(/\r?\n/);
    expect(installer).toBe(`installer /i "${staged.package}" /passive /norestart`);
    expect(started).toBe(`started "${join(directory, "notes & 50%.md")}"`);
    expect(code.trim()).toBe("1618");
    await expect(stat(staged.staging)).rejects.toThrow();
    expect(await readFile(file)).toEqual(PACKAGE);
  });
});

describe("MSI installation folder", () => {
  it("reads a string value from reg.exe's UTF-16 export, with its escapes", () => {
    const exported = Buffer.from("\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Downpad]\r\n" +
      '"Other"="x"\r\n"InstallDir"="C:\\\\Users\\\\Jörg \\"J\\"\\\\Programs\\\\Downpad\\\\"\r\n', "utf16le");
    expect(exportedRegistryString(exported, "InstallDir")).toBe('C:\\Users\\Jörg "J"\\Programs\\Downpad\\');
    expect(exportedRegistryString(exported, "Missing")).toBe("");
    expect(exportedRegistryString(Buffer.from("not an export"), "InstallDir")).toBe("");
  });

  it("finds no installation, instead of failing the start, when no temporary folder can be made", async () => {
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const missing = join(await folder(), "missing", "deeper");
    Object.assign(process.env, { TMPDIR: missing, TEMP: missing, TMP: missing });
    try {
      expect(await registeredMsiFolder()).toBe("");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.runIf(process.platform === "win32")("reads a folder name outside the console's code page from the registry", async () => {
    const key = `HKCU\\Software\\DownpadUpdateTest-${randomUUID()}`;
    const folder = "C:\\Users\\Jörg Åström\\AppData\\Local\\Programs\\Downpad\\";
    const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
    await promisify(execFile)(reg, ["add", key, "/v", "InstallDir", "/t", "REG_SZ", "/d", folder, "/f"]);
    try {
      expect(await registeredMsiFolder(key)).toBe(folder);
    } finally {
      await promisify(execFile)(reg, ["delete", key, "/f"]);
    }
    expect(await registeredMsiFolder(key)).toBe("");
  });
});
