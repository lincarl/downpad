import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "./ci.mjs";
import { parseTag } from "./release.mjs";

/** Limit recovery to first attempts from this repository's supported triggers. */
function eligibleRun(run, repository, defaultBranch) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0
    && /^[a-f0-9]{40}$/.test(run.head_sha ?? "")
    && typeof run.head_branch === "string" && run.head_branch !== "" && !/[\r\n]/.test(run.head_branch)
    && run.path === ".github/workflows/build-installers.yml"
    && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository
    && (run.event === "pull_request" || (run.event === "push"
      && (run.head_branch === defaultBranch || parseTag(run.head_branch) !== null)))
    && run.run_attempt === 1 && run.status === "completed"
    && ["cancelled", "timed_out", "failure"].includes(run.conclusion);
}

/** Read all pages so an unrelated failed job cannot be overlooked. */
async function readPages(request, route, field) {
  const items = [];
  for (let page = 1; ; page++) {
    const response = await request(`${route}?per_page=100&page=${page}`);
    const batch = field ? response[field] : response;
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid page.");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** Retry one confirmed Windows job timeout without retrying test failures. */
export async function recoverWindowsBuild(event, env = process.env, request = createGitHubClient(env)) {
  if (env.GITHUB_EVENT_NAME !== "workflow_run") throw new Error("Recovery requires a workflow_run event.");
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("A valid repository is required.");
  const defaultBranch = event.repository?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("The default branch is required.");
  const source = event.workflow_run;
  if (!eligibleRun(source, repository, defaultBranch)) return "No retry. This is not an eligible first build attempt.";
  const route = `/repos/${repository}/actions/runs/${source.id}`;
  const isPullRequest = source.event === "pull_request";
  const isMainPush = source.event === "push" && source.head_branch === defaultBranch;

  /** Reject stale events, including a maintainer's intervening manual rerun. */
  function sameAttempt(run) {
    return eligibleRun(run, repository, defaultBranch)
      && run.id === source.id && run.head_sha === source.head_sha
      && run.workflow_id === source.workflow_id && run.event === source.event
      && run.head_branch === source.head_branch;
  }
  if (!sameAttempt(await request(route))) return "No retry. The build has changed since this event.";

  /** Require the open PR's current head and target to belong to this repository. */
  function matchingPullRequest(pr) {
    return Number.isSafeInteger(pr?.number) && pr.number > 0 && pr.state === "open"
      && pr.head?.sha === source.head_sha && pr.head?.ref === source.head_branch
      && pr.head?.repo?.full_name === repository
      && pr.base?.repo?.full_name === repository && pr.base?.ref === defaultBranch;
  }

  // Completed workflow runs can have an empty pull_requests array. Resolve the
  // association from the commit, then read the selected PR again before retrying.
  let pullRequestNumber;
  if (isPullRequest) {
    const pulls = await readPages(request, `/repos/${repository}/commits/${source.head_sha}/pulls`);
    pullRequestNumber = pulls.find(matchingPullRequest)?.number;
    if (!pullRequestNumber) return "No retry. No current same-repository pull request matches this build.";
  }

  /** Reject closed or changed PRs and moved tags before starting a fresh runner. */
  async function currentSource() {
    if (isMainPush) return true;
    if (isPullRequest) return matchingPullRequest(await request(`/repos/${repository}/pulls/${pullRequestNumber}`));
    const tag = await request(`/repos/${repository}/commits/${encodeURIComponent(`refs/tags/${source.head_branch}`)}`);
    if (tag.sha !== source.head_sha) return false;
    const comparison = await request(`/repos/${repository}/compare/${source.head_sha}...${encodeURIComponent(`refs/heads/${defaultBranch}`)}`);
    return ["identical", "ahead"].includes(comparison.status);
  }
  if (!await currentSource()) return "No retry. The build source is no longer current or eligible.";

  const jobs = await readPages(request, `${route}/attempts/1/jobs`, "jobs");
  const windows = jobs.filter((job) => job.name === "Windows");
  if (windows.length !== 1 || windows[0].status !== "completed"
    || !["cancelled", "timed_out"].includes(windows[0].conclusion)) {
    return "No retry. Windows did not end with a job timeout or cancellation.";
  }
  if (windows[0].steps?.some((step) => ["failure", "timed_out", "cancelled"].includes(step.conclusion))) {
    return "No retry. A Windows step already failed or was cancelled.";
  }
  if (!Number.isSafeInteger(windows[0].id) || windows[0].id <= 0) throw new Error("Windows has no valid job ID.");
  const candidate = jobs.filter((job) => job.name === "Tag release candidate");
  if (["Select build revision", "Linux"].some((name) =>
    !jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success"))
    || candidate.length !== 1 || candidate[0].status !== "completed"
    || candidate[0].conclusion !== (isMainPush ? "success" : "skipped")
    || jobs.some((job) => job !== windows[0]
      && (job.status !== "completed" || (!["success", "skipped"].includes(job.conclusion)
        && !(isPullRequest && job.name === "reviewed-ci" && job.conclusion === "failure"))))) {
    return "No retry. Another job failed or did not finish successfully.";
  }
  const checkPrefix = `https://api.github.com/repos/${repository}/check-runs/`;
  const checkUrl = windows[0].check_run_url;
  const checkId = typeof checkUrl === "string" && checkUrl.startsWith(checkPrefix)
    ? checkUrl.slice(checkPrefix.length) : "";
  if (!/^[1-9]\d*$/.test(checkId)) throw new Error("Windows has no valid check run URL.");
  const annotations = await readPages(request, `/repos/${repository}/check-runs/${checkId}/annotations`);
  if (!annotations.some((annotation) => annotation.annotation_level === "failure"
    && /^The job has exceeded the maximum execution time of \d+m\d+s\.?$/.test(annotation.message))) {
    return "No retry. GitHub did not confirm that Windows exceeded its job deadline.";
  }
  if (!await currentSource()) return "No retry. The build source changed while checking its timeout.";
  if (!sameAttempt(await request(route))) return "No retry. A new build attempt has already started.";
  // Retry only Windows and its dependent gates on fresh runners. Successful
  // prerequisites keep their outputs, including the existing candidate tag.
  await request(`/repos/${repository}/actions/jobs/${windows[0].id}/rerun`, { method: "POST" });
  return `Requested the single automatic retry for build ${source.id}. Release checks still have to pass.`;
}

/** Use only the trusted workflow event and controls checked out by Actions. */
async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  console.log(await recoverWindowsBuild(event));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
