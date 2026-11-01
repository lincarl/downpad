import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { trackedAgentFiles } from "./check-agent-files.mjs";

const scratch = fileURLToPath(new URL("../dev-temp/agent-files-tests/", import.meta.url));
const script = fileURLToPath(new URL("./check-agent-files.mjs", import.meta.url));

// Git exports GIT_DIR and similar variables to hooks. Clear them so that every git call
// here, including the check under test and its CLI, reads the temporary repository.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
  delete process.env[name];
}

/** Create a repository that commits `tracked` and also holds an ignored private AGENTS.md. */
async function repository(t, tracked) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, env });
  git("init", "-q");
  await writeFile(path.join(root, ".gitignore"), "AGENTS.md\n");
  await writeFile(path.join(root, "AGENTS.md"), "private copy\n");
  await mkdir(path.join(root, "docs"));
  for (const file of tracked) await writeFile(path.join(root, file), "tracked\n");
  git("add", "-f", ".gitignore", ...tracked);
  git("commit", "-q", "-m", "files");
  return root;
}

/** Run the check as `pnpm check` does, in the repository at `cwd`. */
function check(cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
}

test("an ignored private copy and a nested AGENTS.md pass", async (t) => {
  assert.deepEqual(trackedAgentFiles(await repository(t, ["docs/AGENTS.md"])), []);
});

test("a tracked AGENTS.md or CLAUDE.md at the root fails, also from a subdirectory", async (t) => {
  const root = await repository(t, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(trackedAgentFiles(root), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(trackedAgentFiles(path.join(root, "docs")), ["AGENTS.md", "CLAUDE.md"]);
});

test("the command fails with the remedy for each tracked root file and passes for a nested one", async (t) => {
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const result = check(await repository(t, [file]));
    assert.equal(result.status, 1, file);
    assert.equal(result.stderr, `${file} must not be tracked. Remove it with \`git rm --cached ${file}\`.\n`);
  }
  const nested = check(await repository(t, ["docs/AGENTS.md"]));
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stderr, "");
});
