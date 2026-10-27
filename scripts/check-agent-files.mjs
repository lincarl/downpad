import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root files that hold the maintainers' private agent instructions, which this public repository never tracks. */
export const agentFiles = ["AGENTS.md", "CLAUDE.md"];

/**
 * List the agent instruction files that the checkout at `cwd` tracks at its root.
 * A Git hook copies the instructions into each maintainer checkout as an ignored AGENTS.md,
 * and a merge or `git add -f` could still commit that copy.
 */
export function trackedAgentFiles(cwd = process.cwd()) {
  const output = execFileSync(
    "git",
    ["ls-files", "--full-name", "--", ...agentFiles.map((name) => `:(top,literal)${name}`)],
    { cwd, encoding: "utf8" },
  );
  return output.split("\n").filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = trackedAgentFiles();
  if (tracked.length > 0) {
    console.error(`${tracked.join(" and ")} must not be tracked. Remove it with \`git rm --cached ${tracked.join(" ")}\`.`);
    process.exitCode = 1;
  }
}
