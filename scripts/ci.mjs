import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Create a GitHub API client that preserves HTTP status codes for the migration probe. */
export function createGitHubClient(env = process.env, fetcher = fetch) {
  return async (route, { method = "GET", body } = {}) => {
    if (!env.GH_TOKEN) throw new Error("GH_TOKEN is required for GitHub API requests.");
    const response = await fetcher(`https://api.github.com${route}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${route} failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  };
}

/** Validate values before they enter API routes or line-based Actions outputs. */
function repositoryName(value) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? "")) throw new Error("A valid repository full name is required.");
  return value;
}

/** Require the full immutable commit identifier. */
function commitSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("A full 40-character lowercase commit SHA is required.");
  return value;
}

/** Reject missing branch names and output delimiters. */
function branchName(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw new Error("A branch or tag name is required.");
  return value;
}

/** Require a positive pull request number. */
function pullRequestNumber(value) {
  const number = String(value ?? "");
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error("pr_number must be a positive integer.");
  return number;
}

/** Verify that a manual run still uses the selected open same-repository PR head. */
function validateManualHead(pr, repository, sha, ref) {
  if (pr.state !== "open") throw new Error("The pull request must be open.");
  if (pr.head?.repo?.full_name !== repository) throw new Error("Manual PR builds require a same-repository pull request.");
  if (pr.head.sha !== sha) throw new Error("The pull request head changed. Dispatch CI for its current SHA.");
  if (ref !== `refs/heads/${branchName(pr.head.ref)}`) throw new Error("Dispatch the workflow from the pull request head branch.");
}

/** Select the source revision without requiring GitHub reviews or writing statuses. */
export async function prepare(event, env = process.env, request = createGitHubClient(env)) {
  const repository = repositoryName(env.GITHUB_REPOSITORY);
  const defaultBranch = branchName(event.repository?.default_branch);
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const pr = event.pull_request;
    return {
      mode: "pr",
      head_sha: commitSha(pr?.head?.sha),
      head_repository: repositoryName(pr.head.repo?.full_name),
      head_branch: branchName(pr.head.ref),
      default_branch: defaultBranch,
      pr_number: pullRequestNumber(pr.number ?? event.number),
    };
  }
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Expected a pull_request, push, or workflow_dispatch event.");
  const inputs = env.GITHUB_EVENT_NAME === "workflow_dispatch" ? event.inputs ?? {} : {};
  if (inputs.pr_number || inputs.expected_sha) {
    const number = pullRequestNumber(inputs.pr_number);
    const sha = commitSha(inputs.expected_sha);
    if (!env.GITHUB_REF?.startsWith("refs/heads/")) throw new Error("Manual PR builds must dispatch from a branch, not a tag.");
    if (inputs.version) throw new Error("PR builds use the version committed in package.json and cannot override it.");
    if (env.GITHUB_SHA !== sha) throw new Error("expected_sha must match the workflow GITHUB_SHA.");
    if (!/^[\w-]+$/.test(env.GITHUB_ACTOR ?? "")) throw new Error("GITHUB_ACTOR is required for manual PR builds.");
    const permission = await request(`/repos/${repository}/collaborators/${env.GITHUB_ACTOR}/permission`);
    if (!["admin", "maintain"].includes(permission.role_name ?? permission.permission)) throw new Error("Manual PR builds require an admin or maintain actor.");
    const pr = await request(`/repos/${repository}/pulls/${number}`);
    validateManualHead(pr, repository, sha, env.GITHUB_REF);
    return {
      mode: "pr",
      head_sha: sha,
      head_repository: repository,
      head_branch: pr.head.ref,
      default_branch: defaultBranch,
      pr_number: number,
    };
  }
  if (env.GITHUB_REF !== `refs/heads/${defaultBranch}` && !env.GITHUB_REF?.startsWith("refs/tags/")) {
    throw new Error("Non-default branch builds require pr_number and expected_sha.");
  }
  return {
    mode: "regular",
    head_sha: commitSha(env.GITHUB_SHA),
    head_repository: repository,
    head_branch: branchName(env.GITHUB_REF.replace(/^refs\/(heads|tags)\//, "")),
    default_branch: defaultBranch,
    pr_number: "",
  };
}

/** Publish the old required status only while the default branch retains the old gate. */
export async function finish(event, env = process.env, request = createGitHubClient(env)) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !event.inputs?.pr_number) throw new Error("finish is only available for manual PR migration or retry runs.");
  const source = await prepare(event, env, request);
  let legacyGate = true;
  try {
    await request(`/repos/${source.head_repository}/contents/scripts/reviewed-ci.mjs?ref=${encodeURIComponent(source.default_branch)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    legacyGate = false;
  }
  const pr = await request(`/repos/${source.head_repository}/pulls/${source.pr_number}`);
  validateManualHead(pr, source.head_repository, source.head_sha, env.GITHUB_REF);
  const succeeded = [env.CI_PREPARE_RESULT, env.CI_BUILD_RESULT, env.CI_GATE_RESULT].every((result) => result === "success");
  if (legacyGate) {
    if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "")) throw new Error("GITHUB_RUN_ID is required to publish the migration status.");
    await request(`/repos/${source.head_repository}/statuses/${source.head_sha}`, {
      method: "POST",
      body: {
        context: "reviewed-ci",
        state: succeeded ? "success" : "failure",
        description: succeeded ? "Installer CI passed for the current pull request head." : "Installer CI did not complete successfully.",
        target_url: `https://github.com/${source.head_repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      },
    });
  }
  if (!succeeded) throw new Error("CI prepare, build, and gate jobs must all succeed.");
}

/** Run the Actions helper using the event payload supplied by the runner. */
async function main() {
  const command = process.argv[2];
  if (!["prepare", "finish"].includes(command)) throw new Error("Expected prepare or finish.");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (command === "finish") return finish(event);
  const values = await prepare(event);
  const output = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
