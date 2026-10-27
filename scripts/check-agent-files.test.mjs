import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { trackedAgentFiles } from "./check-agent-files.mjs";

/** Create a repository that commits `tracked` and also holds an ignored private AGENTS.md. */
async function repository(t, tracked) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
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

test("an ignored private copy and a nested AGENTS.md pass", async (t) => {
  assert.deepEqual(trackedAgentFiles(await repository(t, ["docs/AGENTS.md"])), []);
});

test("a tracked AGENTS.md or CLAUDE.md at the root fails, also from a subdirectory", async (t) => {
  const root = await repository(t, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(trackedAgentFiles(root), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(trackedAgentFiles(path.join(root, "docs")), ["AGENTS.md", "CLAUDE.md"]);
});
