import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function replaceVersionLine(section, version, label) {
  const matches = section.match(/^version\s*=\s*"[^"]+"\s*$/gm) ?? [];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one version`);
  return section.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${version}"`);
}

function updateCargoToml(text, version) {
  const start = text.indexOf("[package]");
  if (start < 0) throw new Error("Cargo.toml: missing [package]");
  const next = text.indexOf("\n[", start + 1);
  const end = next < 0 ? text.length : next;
  return text.slice(0, start) + replaceVersionLine(text.slice(start, end), version, "Cargo.toml [package]") + text.slice(end);
}

function updateCargoLock(text, version) {
  const starts = [...text.matchAll(/^\[\[package\]\]\r?$/gm)].map((match) => match.index);
  const matches = starts.filter((start, index) => {
    const end = starts[index + 1] ?? text.length;
    return /^name\s*=\s*"md-easy"\s*$/m.test(text.slice(start, end));
  });
  if (matches.length !== 1) throw new Error("Cargo.lock: expected exactly one md-easy package");
  const start = matches[0];
  const index = starts.indexOf(start);
  const end = starts[index + 1] ?? text.length;
  return text.slice(0, start) + replaceVersionLine(text.slice(start, end), version, "Cargo.lock md-easy") + text.slice(end);
}

export async function applyVersionFromTag(tag, root = process.cwd()) {
  const match = stableTag.exec(tag);
  if (!match) throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH`);
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const files = {
    packageJson: path.join(root, "package.json"),
    tauriConfig: path.join(root, "src-tauri", "tauri.conf.json"),
    cargoToml: path.join(root, "src-tauri", "Cargo.toml"),
    cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
  };
  const [packageText, tauriText, cargoToml, cargoLock] = await Promise.all(
    Object.values(files).map((file) => readFile(file, "utf8")),
  );
  const packageJson = JSON.parse(packageText);
  const tauriConfig = JSON.parse(tauriText);
  packageJson.version = version;
  tauriConfig.version = version;
  const outputs = [
    [files.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`],
    [files.tauriConfig, `${JSON.stringify(tauriConfig, null, 2)}\n`],
    [files.cargoToml, updateCargoToml(cargoToml, version)],
    [files.cargoLock, updateCargoLock(cargoLock, version)],
  ];
  await Promise.all(outputs.map(([file, contents]) => writeFile(file, contents)));
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = await applyVersionFromTag(process.argv[2]);
  console.log(`release version: ${version}`);
}
