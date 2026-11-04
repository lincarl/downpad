import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "./ci.mjs";

/** Limit automatic recovery to the first attempt of a default-branch build. */
function eligibleRun(run, repository, defaultBranch) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && /^[a-f0-9]{40}$/.test(run.head_sha ?? "")
    && run.path === ".github/workflows/build-installers.yml"
    && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository
    && run.event === "push" && run.head_branch === defaultBranch
    && run.run_attempt === 1 && run.status === "completed"
    && ["cancelled", "timed_out"].includes(run.conclusion);
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

  /** Reject stale events, including a maintainer's intervening manual rerun. */
  function sameAttempt(run) {
    return eligibleRun(run, repository, defaultBranch)
      && run.id === source.id && run.head_sha === source.head_sha
      && run.workflow_id === source.workflow_id;
  }
  if (!sameAttempt(await request(route))) return "No retry. The build has changed since this event.";
  const jobs = await readPages(request, `${route}/attempts/1/jobs`, "jobs");
  const windows = jobs.filter((job) => job.name === "Windows");
  if (windows.length !== 1 || windows[0].status !== "completed"
    || !["cancelled", "timed_out"].includes(windows[0].conclusion)) {
    return "No retry. Windows did not end with a job timeout or cancellation.";
  }
  if (["Select build revision", "Tag release candidate", "Linux"].some((name) =>
    !jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success"))
    || jobs.some((job) => job !== windows[0]
      && (job.status !== "completed" || !["success", "skipped"].includes(job.conclusion)))) {
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
  if (!sameAttempt(await request(route))) return "No retry. A new build attempt has already started.";
  // Successful jobs keep their original outputs. GitHub reruns failed jobs and
  // their dependants on fresh runners, including the existing candidate's gate.
  await request(`${route}/rerun-failed-jobs`, { method: "POST" });
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
