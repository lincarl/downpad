import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { applyVersionFromTag } from "./apply-version-from-tag.mjs";

/** Create an isolated manifest with optional package and build metadata. */
async function fixture(context, metadata = {}) {
  const directory = path.join(process.cwd(), "dev-temp", "version-tests");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, "run-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "downpad",
    version: "0.2.2",
    main: "electron-dist/main.js",
    ...metadata,
  }));
  return root;
}

test("applies a stable tag and adds a numeric build version when build settings are absent", async (context) => {
  const root = await fixture(context);

  assert.equal(await applyVersionFromTag("v1.2.3", root), "1.2.3");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "package.json"))), {
    name: "downpad",
    version: "1.2.3",
    main: "electron-dist/main.js",
    build: { buildVersion: "1.2.3.0" },
  });
});

test("keeps the public RC suffix while using a numeric build version", async (context) => {
  const root = await fixture(context);

  assert.equal(await applyVersionFromTag("v0.3.6-rc2", root), "0.3.6-rc2");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json")));
  assert.equal(manifest.version, "0.3.6-rc2");
  assert.equal(manifest.build.buildVersion, "0.3.6.0");
});

test("repeated updates replace both versions and preserve unrelated package and build metadata", async (context) => {
  const metadata = {
    description: "Release version fixture",
    build: {
      buildVersion: "9.9.9.9",
      appId: "org.example.downpad",
      artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
      directories: { output: "release", buildResources: "build" },
      files: ["dist/**/*", "electron-dist/**/*"],
      win: { target: ["msi"], icon: "build/icon.ico" },
      msi: { oneClick: false, perMachine: false },
    },
  };
  const root = await fixture(context, metadata);

  for (const [version, buildVersion] of [
    ["1.2.3-rc1", "1.2.3.0"],
    ["1.2.3-rc2", "1.2.3.0"],
    ["1.2.3", "1.2.3.0"],
    ["1.2.4-rc1", "1.2.4.0"],
  ]) {
    assert.equal(await applyVersionFromTag(`v${version}`, root), version);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "package.json"))), {
      name: "downpad",
      main: "electron-dist/main.js",
      ...metadata,
      version,
      build: { ...metadata.build, buildVersion },
    });
  }
});

test("rejects malformed and other prerelease tags without changing the version", async (context) => {
  const root = await fixture(context);
  for (const tag of ["1.2.3", "v01.2.3", "v1.2.3-beta.1", "v1.2.3-rc0", "v1.2.3-rc1.1"]) {
    await assert.rejects(() => applyVersionFromTag(tag, root), /expected vMAJOR\.MINOR\.PATCH or vMAJOR\.MINOR\.PATCH-rcN/);
  }
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"))).version, "0.2.2");
});
