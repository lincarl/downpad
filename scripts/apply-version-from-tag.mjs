import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTag } from "./release.mjs";

// The manifest supplies Electron's version and the version shown in Settings.
// pnpm's lockfile records dependencies and does not contain the app version.
// A candidate tag such as v1.2.3-rc4 gives the version 1.2.3-rc4.
export async function applyVersionFromTag(tag, root = process.cwd()) {
  if (!parseTag(tag)) throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rcN`);
  const version = tag.slice(1);
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
