import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

const version = "2.103.2";
const releaseUrl = `https://github.com/cli/cli/releases/download/v${version}`;

/** Download an official release asset, failing on HTTP errors or stalled requests. */
async function download(name) {
  const response = await fetch(`${releaseUrl}/${name}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GitHub CLI download failed with HTTP ${response.status} for ${name}.`);
  return Buffer.from(await response.arrayBuffer());
}

/** Install the checksum-verified CLI inside the checkout for subsequent Actions steps. */
async function main() {
  if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform)) {
    throw new Error(`Unsupported GitHub CLI platform ${process.platform}/${process.arch}. Expected Linux or Windows x64.`);
  }
  if (!process.env.GITHUB_WORKSPACE || !process.env.GITHUB_PATH) {
    throw new Error("GITHUB_WORKSPACE and GITHUB_PATH are required.");
  }

  const windows = process.platform === "win32";
  const archiveName = `gh_${version}_${windows ? "windows_amd64.zip" : "linux_amd64.tar.gz"}`;
  const [archive, checksums] = await Promise.all([
    download(archiveName),
    download(`gh_${version}_checksums.txt`),
  ]);
  const entries = checksums.toString("utf8").split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter((entry) => entry?.[2] === archiveName);
  if (entries.length !== 1) throw new Error(`Expected exactly one official checksum for ${archiveName}.`);
  const checksum = createHash("sha256").update(archive).digest("hex");
  if (checksum !== entries[0][1]) throw new Error(`SHA256 mismatch for ${archiveName}.`);
  console.log(`Verified ${archiveName} SHA256 ${checksum}`);

  const scratch = path.join(path.resolve(process.env.GITHUB_WORKSPACE), "dev-temp");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, `github-cli-${version}-`));
  const archivePath = path.join(directory, archiveName);
  await writeFile(archivePath, archive);
  // Windows' bundled bsdtar supports ZIP files. Avoid Git Bash's GNU tar.
  const tar = windows ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archivePath, "-C", directory], { stdio: "inherit" });

  const binDirectory = windows ? path.join(directory, "bin") : path.join(directory, `gh_${version}_linux_amd64`, "bin");
  const executable = path.join(binDirectory, windows ? "gh.exe" : "gh");
  const installedVersion = execFileSync(executable, ["--version"], { encoding: "utf8" });
  if (!installedVersion.startsWith(`gh version ${version} `)) throw new Error("Installed GitHub CLI version does not match the pin.");
  await appendFile(process.env.GITHUB_PATH, `${binDirectory}\n`);
  process.stdout.write(installedVersion);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
