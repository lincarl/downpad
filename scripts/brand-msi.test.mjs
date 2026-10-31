import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import brandMsi from "./brand-msi.mjs";

/** Writes a minimal generated WiX project and applies the packaging hook. */
async function project(t, upgrade) {
  const root = path.resolve("dev-temp/brand-msi-tests");
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(path.join(root, "run-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "project.wxs");
  const source = `<Wix><Product>
    ${upgrade}
    <ComponentGroup Id="ProductComponents">
      <Component><ProgId Id="Downpad.md"/><ProgId Id="Downpad.markdown"/></Component>
    </ComponentGroup>
  </Product></Wix>`;
  await writeFile(file, source);
  return { file, source };
}

test("major upgrades remove the previous product inside the rollback transaction", async (t) => {
  for (const schedule of ["", ' Schedule="afterInstallValidate"', " Schedule='afterInstallFinalize'"]) {
    const { file } = await project(t, `<MajorUpgrade AllowSameVersionUpgrades="yes"${schedule} DowngradeErrorMessage="A newer version is installed."/>`);
    await brandMsi(file);
    const result = await readFile(file, "utf8");
    assert.match(result, /<MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version is installed\." Schedule="afterInstallInitialize"\/>/);
    assert.match(result, /<ProgId Id="mdeasy\.md"/);
    assert.match(result, /<ProgId Id="mdeasy\.markdown"/);
    assert.match(result, /RegistryValue Root="HKMU" Key="Software\\Downpad" Name="InstallDir"/);
  }
});

test("an unexpected upgrade definition fails packaging without changing the project", async (t) => {
  for (const upgrade of ["", "<MajorUpgrade/><MajorUpgrade/>"]) {
    const { file, source } = await project(t, upgrade);
    await assert.rejects(brandMsi(file), /Cannot schedule rollback/);
    assert.equal(await readFile(file, "utf8"), source);
  }
});
