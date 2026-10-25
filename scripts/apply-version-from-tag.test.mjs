import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { applyVersionFromTag } from "./apply-version-from-tag.mjs";

async function fixture(context) {
  const directory = path.join(process.cwd(), "dev-temp", "version-tests");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, "run-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"downpad","version":"0.2.2","main":"electron-dist/main.js"}\n');
  return root;
}

test("applies a stable tag without changing other Electron build metadata", async (context) => {
  const root = await fixture(context);

  assert.equal(await applyVersionFromTag("v1.2.3", root), "1.2.3");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "package.json"))), {
    name: "downpad",
    version: "1.2.3",
    main: "electron-dist/main.js",
  });
});

test("rejects malformed or prerelease tags without changing the version", async (context) => {
  const root = await fixture(context);
  for (const tag of ["1.2.3", "v01.2.3", "v1.2.3-beta.1"]) {
    await assert.rejects(() => applyVersionFromTag(tag, root), /expected vMAJOR\.MINOR\.PATCH/);
  }
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"))).version, "0.2.2");
});
