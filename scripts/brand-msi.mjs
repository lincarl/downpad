import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// electron-builder calls this hook after it writes the WiX project and before it
// compiles the MSI. It swaps WiX's stock dialog images for Downpad's bitmaps, and
// gives the file types the ProgIds of md-easy, the app's earlier name.

const bitmaps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "msi");
const xml = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Renames the ProgIds that electron-builder derives from the product name,
 *  Downpad.md and Downpad.markdown, to md-easy's mdeasy.md and mdeasy.markdown.
 *  A default .md app chosen in Windows names its ProgId, and the upgrade from
 *  md-easy removes md-easy's ProgIds, so only the same names keep that choice. */
function keepLegacyProgIds(project, projectFile) {
  let renamed = 0;
  const kept = project.replace(/<ProgId Id="Downpad\.(md|markdown)"/g, (_match, extension) => {
    renamed += 1;
    return `<ProgId Id="mdeasy.${extension}"`;
  });
  if (renamed !== 2) throw new Error(`Cannot keep md-easy's ProgIds in ${projectFile}: found ${renamed} of the 2 Downpad ProgIds.`);
  return kept;
}

/** Adds the banner and welcome bitmaps to the WiX project at `projectFile` and
 *  keeps md-easy's ProgIds. */
export default async function brandMsi(projectFile) {
  const original = await readFile(projectFile, "utf8");
  if (!original.includes("</Product>")) throw new Error(`Cannot brand ${projectFile}: no WiX Product element.`);
  const project = keepLegacyProgIds(original, projectFile);
  // light.exe runs in the project's folder. A relative path also resolves under Wine.
  const source = (name) => xml(path.relative(path.dirname(projectFile), path.join(bitmaps, name)).split(path.sep).join("\\"));
  const variables = `<WixVariable Id="WixUIBannerBmp" Value="${source("banner.bmp")}"/>\n`
    + `    <WixVariable Id="WixUIDialogBmp" Value="${source("dialog.bmp")}"/>\n`;
  await writeFile(projectFile, project.replace("</Product>", () => `  ${variables}  </Product>`));
}
