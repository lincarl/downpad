import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTag } from "./release.mjs";

/** Write the public app version and numeric Windows build version from a release tag. */
export async function applyVersionFromTag(tag, root = process.cwd()) {
  const parsed = parseTag(tag);
  if (!parsed) throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rcN`);
  const version = tag.slice(1);
  const file = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(file, "utf8"));
  packageJson.version = version;
  // PE file versions must be numeric even when the public version has an RC suffix.
  packageJson.build = { ...packageJson.build, buildVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}.0` };
  await writeFile(file, `${JSON.stringify(packageJson, null, 2)}\n`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = await applyVersionFromTag(process.argv[2]);
  console.log(`Release version ${version}`);
}
