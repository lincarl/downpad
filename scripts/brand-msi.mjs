import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// electron-builder calls this hook after it writes the WiX project and before it
// compiles the MSI. It swaps WiX's stock dialog images for md-easy's bitmaps.

const bitmaps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "msi");
const xml = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Adds the banner and welcome bitmaps to the WiX project at `projectFile`. */
export default async function brandMsi(projectFile) {
  const project = await readFile(projectFile, "utf8");
  if (!project.includes("</Product>")) throw new Error(`Cannot brand ${projectFile}: no WiX Product element.`);
  // light.exe runs in the project's folder. A relative path also resolves under Wine.
  const source = (name) => xml(path.relative(path.dirname(projectFile), path.join(bitmaps, name)).split(path.sep).join("\\"));
  const variables = `<WixVariable Id="WixUIBannerBmp" Value="${source("banner.bmp")}"/>\n`
    + `    <WixVariable Id="WixUIDialogBmp" Value="${source("dialog.bmp")}"/>\n`;
  await writeFile(projectFile, project.replace("</Product>", () => `  ${variables}  </Product>`));
}
