import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// electron-builder calls this hook after it writes the WiX project and before it
// compiles the MSI. It swaps WiX's stock dialog images for Downpad's bitmaps,
// gives the file types the ProgIds of md-easy, the app's earlier name, and
// records the installation folder for the updater. Major upgrades remove the
// old product inside the transaction so a failed installation restores it.

const bitmaps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "msi");
const xml = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Includes removal of the old product in Windows Installer's rollback.
 *  Removing it before installing new files also permits component changes. */
function transactionalMajorUpgrade(project, projectFile) {
  let upgrades = 0;
  const scheduled = project.replace(/<MajorUpgrade\b[^>]*\/>/g, (element) => {
    upgrades += 1;
    return element.replace(/\sSchedule=(["'])[^"']*\1/, "").replace(/\s*\/>$/, ' Schedule="afterInstallInitialize"/>');
  });
  if (upgrades !== 1) throw new Error(`Cannot schedule rollback in ${projectFile}: found ${upgrades} MajorUpgrade elements.`);
  return scheduled;
}

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

/** Adds a component that writes the installation folder to Software\Downpad,
 *  InstallDir, under HKMU: HKCU for an installation for the current user and
 *  HKLM for one for all users. A copy that runs from the folder recorded in
 *  HKCU installs updates itself (electron/updateInstall.ts). The component's
 *  GUID must stay the same in every release. */
function recordInstallFolder(project, projectFile) {
  const group = /(<ComponentGroup Id="ProductComponents"[^>]*>[\s\S]*?)(<\/ComponentGroup>)/;
  if (!group.test(project)) throw new Error(`Cannot record the installation folder in ${projectFile}: no ProductComponents group.`);
  const component = '<Component Id="downpadInstallFolder" Guid="{6BAD51B4-ED13-4291-97F4-6AB9EBBA7FEB}">\n' +
    '        <RegistryValue Root="HKMU" Key="Software\\Downpad" Name="InstallDir" Type="string" Value="[APPLICATIONFOLDER]" KeyPath="yes"/>\n' +
    "      </Component>\n    ";
  return project.replace(group, (_match, start, end) => `${start}  ${component}${end}`);
}

/** Adds the banner and welcome bitmaps to the WiX project at `projectFile`,
 *  keeps md-easy's ProgIds, records the installation folder and enables upgrade rollback. */
export default async function brandMsi(projectFile) {
  const original = await readFile(projectFile, "utf8");
  if (!original.includes("</Product>")) throw new Error(`Cannot brand ${projectFile}: no WiX Product element.`);
  const project = recordInstallFolder(keepLegacyProgIds(transactionalMajorUpgrade(original, projectFile), projectFile), projectFile);
  // light.exe runs in the project's folder. A relative path also resolves under Wine.
  const source = (name) => xml(path.relative(path.dirname(projectFile), path.join(bitmaps, name)).split(path.sep).join("\\"));
  const variables = `<WixVariable Id="WixUIBannerBmp" Value="${source("banner.bmp")}"/>\n`
    + `    <WixVariable Id="WixUIDialogBmp" Value="${source("dialog.bmp")}"/>\n`;
  await writeFile(projectFile, project.replace("</Product>", () => `  ${variables}  </Product>`));
}
