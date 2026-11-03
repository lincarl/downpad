import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import brandMsi from "./brand-msi.mjs";

const scratch = fileURLToPath(new URL("../dev-temp/brand-msi-tests/", import.meta.url));

/** Writes a minimal generated WiX project, changed by `edit`, for the packaging hook. */
async function project(t, upgrade, edit = (source) => source) {
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(path.join(scratch, "run-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "project.wxs");
  const source = edit(`<Wix><Product>
    ${upgrade}
    <ComponentGroup Id="ProductComponents">
      <Component><ProgId Id="Downpad.md"/><ProgId Id="Downpad.markdown"/></Component>
    </ComponentGroup>
  </Product></Wix>`);
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

test("the install folder component keeps its GUID and the bitmaps resolve from the project's folder", async (t) => {
  const { file } = await project(t, "<MajorUpgrade/>");
  await brandMsi(file);
  const result = await readFile(file, "utf8");
  assert.match(result, /<ComponentGroup Id="ProductComponents">[\s\S]*<Component Id="downpadInstallFolder" Guid="\{6BAD51B4-ED13-4291-97F4-6AB9EBBA7FEB\}">\s*<RegistryValue Root="HKMU" Key="Software\\Downpad" Name="InstallDir" Type="string" Value="\[APPLICATIONFOLDER\]" KeyPath="yes"\/>\s*<\/Component>\s*<\/ComponentGroup>/);
  // light.exe resolves the bitmaps from the project's folder, also under Wine.
  // This test's project is three levels below the repository.
  assert.match(result, /<WixVariable Id="WixUIBannerBmp" Value="\.\.\\\.\.\\\.\.\\build\\msi\\banner\.bmp"\/>\s*<WixVariable Id="WixUIDialogBmp" Value="\.\.\\\.\.\\\.\.\\build\\msi\\dialog\.bmp"\/>\s*<\/Product>/);
});

test("installation closes current and legacy apps without bypassing their unsaved-document prompts", async (t) => {
  const { file } = await project(t, "<MajorUpgrade/>");
  await brandMsi(file);
  const result = await readFile(file, "utf8");
  const applications = [...result.matchAll(/<util:CloseApplication\b([^>]*)>(.*?)<\/util:CloseApplication>/g)];
  assert.equal(applications.length, 2);
  for (const [index, target] of ["Downpad.exe", "md-easy.exe"].entries()) {
    const attributes = Object.fromEntries([...applications[index][1].matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => match.slice(1)));
    assert.equal(attributes["xmlns:util"], "http://wixtoolset.org/schemas/v4/wxs/util");
    assert.equal(attributes.Target, target);
    assert.equal(attributes.CloseMessage, "yes");
    assert.equal(attributes.RebootPrompt, "no");
    assert.equal(attributes.Timeout, "60");
    assert.equal(attributes.Property, index === 0 ? "DOWNPAD_RUNNING" : "MDEASY_RUNNING");
    assert.equal(applications[index][2], 'NOT (REMOVE ~= "ALL")');
    for (const unsafe of ["TerminateProcess", "EndSessionMessage", "ElevatedCloseMessage", "ElevatedEndSessionMessage", "PromptToContinue"]) {
      assert.equal(attributes[unsafe], undefined);
    }
  }
  const config = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(config.build.msi.additionalWixArgs, ["-ext", "WixUtilExtension"]);
});

test("a refused close stops installation before files-in-use detection and old-product removal", async (t) => {
  const { file } = await project(t, "<MajorUpgrade/>");
  await brandMsi(file);
  const result = await readFile(file, "utf8");
  assert.match(result, /<CustomAction Id="DownpadRequireClosed" Error="[^"]*Save your work[^"]*"\/>/);
  assert.match(result, /<Custom Action="WixCloseApplications" Before="DownpadRequireClosed">NOT \(REMOVE ~= "ALL"\)<\/Custom>/);
  assert.match(result, /<Custom Action="DownpadRequireClosed" Before="InstallValidate">NOT \(REMOVE ~= "ALL"\) AND \(DOWNPAD_RUNNING OR MDEASY_RUNNING\)<\/Custom>/);
  assert.match(result, /<MajorUpgrade Schedule="afterInstallInitialize"\/>/);
});

test("an unexpected upgrade definition fails packaging without changing the project", async (t) => {
  for (const upgrade of ["", "<MajorUpgrade/><MajorUpgrade/>"]) {
    const { file, source } = await project(t, upgrade);
    await assert.rejects(brandMsi(file), /Cannot schedule rollback/);
    assert.equal(await readFile(file, "utf8"), source);
  }
});

test("a project without both Downpad ProgIds, the component group or a Product element fails packaging without changing it", async (t) => {
  const cases = [
    [(source) => source.replace('<ProgId Id="Downpad.markdown"/>', ""), /found 1 of the 2 Downpad ProgIds/],
    [(source) => source.replaceAll('Id="Downpad.', 'Id="Other.'), /found 0 of the 2 Downpad ProgIds/],
    [(source) => source.replace('Id="ProductComponents"', 'Id="OtherComponents"'), /no ProductComponents group/],
    [(source) => source.replace("</Product>", ""), /no WiX Product element/],
  ];
  for (const [edit, error] of cases) {
    const { file, source } = await project(t, "<MajorUpgrade/>", edit);
    await assert.rejects(brandMsi(file), error);
    assert.equal(await readFile(file, "utf8"), source);
  }
});
