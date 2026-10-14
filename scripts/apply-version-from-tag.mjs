import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// The manifest supplies Electron's version and the version shown in Settings.
// pnpm's lockfile records dependencies and does not contain the app version.
export async function applyVersionFromTag(tag, root = process.cwd()) {
  const match = stableTag.exec(tag);
  if (!match) throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH`);
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const file = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(file, "utf8"));
  packageJson.version = version;
  await writeFile(file, `${JSON.stringify(packageJson, null, 2)}\n`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = await applyVersionFromTag(process.argv[2]);
  console.log(`Release version ${version}`);
}
