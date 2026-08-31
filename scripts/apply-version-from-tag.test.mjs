import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyVersionFromTag } from "./apply-version-from-tag.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "md-easy-version-"));
  await mkdir(path.join(root, "src-tauri"));
  await writeFile(path.join(root, "package.json"), '{"name":"md-easy","version":"0.2.2"}\n');
  await writeFile(path.join(root, "src-tauri", "tauri.conf.json"), '{"version":"0.2.2"}\n');
  await writeFile(path.join(root, "src-tauri", "Cargo.toml"), '[package]\nname = "md-easy"\nversion = "0.2.2"\n');
  await writeFile(path.join(root, "src-tauri", "Cargo.lock"), '[[package]]\nname = "md-easy"\nversion = "0.2.2"\n');
  return root;
}

test("applies a stable tag version to all build metadata", async () => {
  const root = await fixture();

  assert.equal(await applyVersionFromTag("v1.2.3", root), "1.2.3");
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"))).version, "1.2.3");
  assert.equal(JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"))).version, "1.2.3");
  assert.match(await readFile(path.join(root, "src-tauri", "Cargo.toml"), "utf8"), /^version = "1\.2\.3"$/m);
  assert.match(await readFile(path.join(root, "src-tauri", "Cargo.lock"), "utf8"), /^version = "1\.2\.3"$/m);
});

test("rejects tags that are not stable semantic versions", async () => {
  await assert.rejects(() => applyVersionFromTag("1.2.3", "."), /expected vMAJOR\.MINOR\.PATCH/);
  await assert.rejects(() => applyVersionFromTag("v01.2.3", "."), /expected vMAJOR\.MINOR\.PATCH/);
});
