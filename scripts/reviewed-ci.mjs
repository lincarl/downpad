import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REVIEW_CONTEXT = "reviewed-ci";
export const REVIEW_BOTS = ["coderabbitai[bot]"];
const REVIEW_APP_IDS = { "coderabbitai[bot]": 347564 };
const incompleteReview = /(?:\breview(?:ing)?(?:\s+has\s+been|\s+was|\s+is)?\s+(?:skipped|paused|failed|pending|in progress)\b|\bunable to (?:complete|perform) (?:the )?review\b|^\s*(?:[#>*!\s]|<[^>]+>)*(?:rate[- ]limit(?:ed| exceeded| reached)?|quota exceeded)\b)/im;

function newest(entries) {
  return [...entries].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)
    || (b.updated_at ?? b.submitted_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.submitted_at ?? a.created_at ?? ""))[0];
}

// Only a submitted review shows that a bot reviewed the requested head. A score
// or passing status by itself does not. GitHub rewrites an approval's commit_id
// to the new head when a push keeps the pull request's changes the same, such as
// a rebase or a merge from the base branch. A review of the head therefore counts
// only when it was submitted after that head was pushed (`signals.headPushedAt`).
export function validateReviewGate(pr, reviews, threads, expectedSha, bots = REVIEW_BOTS, signals = {}) {
  const problems = [];
  if (pr.state !== "open") problems.push("The pull request must be open.");
  if (pr.draft) problems.push("The pull request is still a draft.");
  if (pr.head.sha !== expectedSha) problems.push("The pull request head changed. Request CI for its new SHA.");
  if (pr.reviewDecision === "CHANGES_REQUESTED") problems.push("GitHub reports changes requested.");
  if (pr.reviewDecision === "REVIEW_REQUIRED") problems.push("GitHub still requires an approving review.");
  const decisions = new Map();
  for (const review of [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""))) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) decisions.set(review.user?.login, review.state);
  }
  if ([...decisions.values()].includes("CHANGES_REQUESTED")) problems.push("An active review requests changes.");
  if (threads.some((thread) => !thread.isResolved)) problems.push("Resolve every review thread before requesting CI.");
  const pushedAt = Date.parse(signals.headPushedAt ?? "");
  if (Number.isNaN(pushedAt)) problems.push("GitHub has not reported when the head was pushed.");
  for (const login of bots) {
    // CodeRabbit creates blank COMMENTED reviews when replying to inline chat.
    const onHead = reviews.filter((entry) => entry.user?.login === login && entry.user.type === "Bot" && entry.commit_id === expectedSha
      && !(entry.state === "COMMENTED" && entry.submitted_at && !entry.body?.trim()));
    // Unsubmitted reviews stay, so a pending review still blocks.
    const beforePush = (entry) => entry.submitted_at && Date.parse(entry.submitted_at) <= pushedAt;
    const review = newest(onHead.filter((entry) => !beforePush(entry)));
    if (!review || !review.submitted_at || !["COMMENTED", "APPROVED"].includes(review.state) ||
      (review.state === "COMMENTED" && !review.body?.trim())) {
      problems.push(!review && onHead.some(beforePush)
        ? `${login}'s review of ${expectedSha} was submitted before that commit was pushed, so it describes an earlier revision. Dismiss it and ask for a full review (docs/ci.md).`
        : `${login} has not submitted a completed review of ${expectedSha}.`);
    } else if (review.body && incompleteReview.test(review.body)) {
      problems.push(`${login} reported an incomplete, paused, failed, skipped, or rate-limited review.`);
    }
    const checks = (signals.checkRuns ?? []).filter((check) => check.app?.id === REVIEW_APP_IDS[login]);
    for (const name of new Set(checks.map((check) => check.name))) {
      const check = newest(checks.filter((entry) => entry.name === name));
      if (check.status !== "completed" || check.conclusion !== "success") problems.push(`${login}'s ${name} check has not completed successfully.`);
    }
    const statuses = (signals.statuses ?? []).filter((status) => status.creator?.login === login && status.creator.type === "Bot");
    for (const context of new Set(statuses.map((status) => status.context))) {
      if (newest(statuses.filter((entry) => entry.context === context)).state !== "success") problems.push(`${login}'s ${context} status has not passed.`);
    }
    const comment = [...(signals.comments ?? [])]
      .filter((entry) => entry.user?.login === login && entry.user.type === "Bot")
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
    if (comment && (!review?.submitted_at || comment.updated_at >= review.submitted_at) && incompleteReview.test(comment.body ?? "")) {
      problems.push(`${login}'s latest comment reports that its review has not completed.`);
    }
  }
  return problems;
}

export function selectPreviousAttempt(statuses) {
  return statuses.find((status) => status.context === REVIEW_CONTEXT
    && status.creator?.login === "github-actions[bot]"
    && (status.state !== "pending" || status.description?.startsWith("Running reviewed CI")));
}

// Tag dispatches build only their own revision. A PR request must select a
// branch so its source cannot be confused with the release tag's source.
export function validateDispatchRef(ref, number, defaultBranch) {
  if (number) {
    if (!ref?.startsWith("refs/heads/")) throw new Error("PR builds must dispatch from a branch, not a tag.");
  } else if (ref !== `refs/heads/${defaultBranch}` && !ref?.startsWith("refs/tags/")) {
    throw new Error("PR branch builds require pr_number and expected_sha.");
  }
}

async function github(route, { method = "GET", body } = {}) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required.");
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${route} failed with HTTP ${response.status}.`);
  return response.status === 204 ? undefined : response.json();
}

async function paginate(route, key, request = github) {
  const items = [];
  for (let page = 1; page <= 25; page++) {
    const response = await request(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const values = key ? response[key] : response;
    items.push(...values);
    if (values.length < 100) return items;
  }
  throw new Error("GitHub pagination exceeded the gate's limit. No review decision was made.");
}

// Pin commit evidence to the requested revision, then refresh mutable review
// decisions and threads after collection. Every graph page checks the head. The
// head branch's activity, newest first, gives GitHub's time for the push that
// made the requested SHA its head.
export async function readPullRequest(repository, number, expectedSha, request = github) {
  const pr = await request(`/repos/${repository}/pulls/${number}`);
  if (pr.head.sha !== expectedSha) throw new Error("The pull request head changed. Request CI for its new SHA.");
  if (!pr.head.repo?.full_name) throw new Error("The pull request's head repository is unavailable. No review decision was made.");
  const branch = encodeURIComponent(`refs/heads/${pr.head.ref}`);
  const [reviews, checkRuns, statuses, comments, activity] = await Promise.all([
    paginate(`/repos/${repository}/pulls/${number}/reviews`, undefined, request),
    paginate(`/repos/${repository}/commits/${expectedSha}/check-runs?filter=latest`, "check_runs", request),
    paginate(`/repos/${repository}/commits/${expectedSha}/statuses`, undefined, request),
    paginate(`/repos/${repository}/issues/${number}/comments`, undefined, request),
    request(`/repos/${pr.head.repo.full_name}/activity?ref=${branch}&per_page=100`),
  ]);
  const headPush = activity.find((entry) => entry.after === expectedSha && ["push", "force_push", "branch_creation"].includes(entry.activity_type));
  if (!headPush?.timestamp) throw new Error("GitHub has no record of the push that made the requested SHA the head. No review decision was made.");
  const [owner, name] = repository.split("/");
  const threads = [];
  let cursor = null;
  for (let page = 0; page < 25; page++) {
    const result = await request("/graphql", {
      method: "POST",
      body: {
        query: `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              headRefOid
              reviewDecision
              reviewThreads(first: 100, after: $cursor) {
                nodes { isResolved }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        variables: { owner, name, number: Number(number), cursor },
      },
    });
    if (result.errors?.length) throw new Error("GitHub could not read the review threads. No review decision was made.");
    const data = result.data?.repository?.pullRequest;
    if (!data) throw new Error("GitHub did not return the pull request's review state.");
    if (data.headRefOid !== expectedSha) throw new Error("The pull request head changed. Request CI for its new SHA.");
    pr.reviewDecision = data.reviewDecision;
    threads.push(...data.reviewThreads.nodes);
    if (!data.reviewThreads.pageInfo.hasNextPage) {
      const latest = await request(`/repos/${repository}/pulls/${number}`);
      return { pr: { ...latest, reviewDecision: pr.reviewDecision }, threads, reviews, signals: { checkRuns, statuses, comments, headPushedAt: headPush.timestamp } };
    }
    cursor = data.reviewThreads.pageInfo.endCursor;
  }
  throw new Error("Review-thread pagination exceeded the gate's limit. No review decision was made.");
}

async function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

async function setStatus(repository, sha, state, description, targetUrl) {
  const runId = process.env.GITHUB_RUN_ID;
  await github(`/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    body: {
      context: REVIEW_CONTEXT,
      state,
      description: description.slice(0, 140),
      ...(targetUrl || runId ? { target_url: targetUrl ?? `https://github.com/${repository}/actions/runs/${runId}` } : {}),
    },
  });
}

function pullRequestNumber(value) {
  if (!/^[1-9]\d*$/.test(value ?? "")) throw new Error("pr_number must be a positive integer.");
  return value;
}

function expectedHead(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("expected_sha must be the full 40-character lowercase commit SHA.");
  return value;
}

async function main() {
  const command = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is required.");
  if (command === "initialize") {
    const number = pullRequestNumber(process.env.PR_NUMBER);
    const pr = await github(`/repos/${repository}/pulls/${number}`);
    await setStatus(repository, pr.head.sha, "pending", "Waiting for CodeRabbit review and an explicit CI request.");
    return;
  }
  if (!["request", "finalize"].includes(command)) throw new Error("Expected initialize, request, or finalize.");
  const number = process.env.PR_NUMBER;
  if (command === "request" && number && process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    validateDispatchRef(process.env.GITHUB_REF, number);
  }
  if (!number && command === "request") {
    const metadata = await github(`/repos/${repository}`);
    if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
      validateDispatchRef(process.env.GITHUB_REF, number, metadata.default_branch);
    }
    if (process.env.EXPECTED_SHA || process.env.RETRY === "true") throw new Error("expected_sha and retry require pr_number.");
    await output({ mode: "regular", head_sha: expectedHead(process.env.GITHUB_SHA), head_repository: repository, should_build: true });
    return;
  }
  pullRequestNumber(number);
  const sha = expectedHead(process.env.EXPECTED_SHA);
  if (command === "request" && process.env.VERSION?.trim()) {
    throw new Error("PR builds use the version committed in package.json. Version overrides are available for main builds only.");
  }
  const { pr, threads, reviews, signals } = await readPullRequest(repository, number, sha).catch(async (error) => {
    if (command === "finalize") await setStatus(repository, sha, "error", "Cannot verify the reviewed PR revision. Request an explicit retry.");
    throw error;
  });
  const problems = validateReviewGate(pr, reviews, threads, sha, REVIEW_BOTS, signals);
  if (command === "finalize") {
    if (pr.head.sha !== sha) {
      await setStatus(repository, sha, "error", "This build was superseded by a new pull request head.");
      throw new Error(problems.join("\n"));
    }
    if (process.env.BUILD_RESULT !== "success" || problems.length) {
      await setStatus(repository, sha, "failure", problems.length ? "Review requirements changed during CI." : "Reviewed CI failed. An explicit retry is required.");
      throw new Error(problems.join("\n") || `Installer jobs finished with ${process.env.BUILD_RESULT}.`);
    }
    await setStatus(repository, sha, "success", "CodeRabbit reviewed the current head and all installer checks passed.");
    return;
  }
  if (problems.length) {
    if (pr.head.sha === sha) await setStatus(repository, sha, "pending", "CodeRabbit review or unresolved findings still block CI.");
    throw new Error(problems.join("\n"));
  }
  const previous = selectPreviousAttempt(signals.statuses);
  if (previous?.state === "success" && process.env.RETRY !== "true") {
    const runMatch = previous.target_url?.match(new RegExp(`^https://github\\.com/${repository.replaceAll(".", "\\.")}/actions/runs/(\\d+)$`));
    if (!runMatch) throw new Error("The previous CI status has no verifiable workflow run. Request an explicit retry.");
    const run = await github(`/repos/${repository}/actions/runs/${runMatch[1]}`);
    if (run.status !== "completed" || run.conclusion !== "success" || run.path !== ".github/workflows/build-installers.yml" || run.event !== "workflow_dispatch") {
      throw new Error("The previous CI run did not finish successfully. Request an explicit retry.");
    }
    const artifacts = await github(`/repos/${repository}/actions/runs/${runMatch[1]}/artifacts?per_page=100`);
    for (const platform of ["linux", "windows"]) {
      if (!artifacts.artifacts.some((artifact) => artifact.name.startsWith(`md-easy-${platform}-`) && artifact.name.endsWith(`-${sha}`) && !artifact.expired)) {
        throw new Error(`The previous CI run has no retained ${platform} installer evidence for this SHA. Request an explicit retry.`);
      }
    }
    await setStatus(repository, sha, "success", "CodeRabbit reviewed the current head. Reused successful installer checks.", previous.target_url);
    await output({ mode: "pr", head_sha: sha, head_repository: pr.head.repo.full_name, should_build: false });
    console.log("A successful reviewed CI build already exists for this revision.");
    return;
  }
  if (["error", "failure"].includes(previous?.state) && process.env.RETRY !== "true") {
    throw new Error("This revision already failed CI. Set retry=true to request another build.");
  }
  if (previous?.state === "pending" && previous.description?.startsWith("Running reviewed CI") && process.env.RETRY !== "true") {
    throw new Error("This revision already has an unfinished CI attempt. Set retry=true after it stops.");
  }
  await setStatus(repository, sha, "pending", `Running reviewed CI for pull request #${number}.`);
  await output({ mode: "pr", head_sha: sha, head_repository: pr.head.repo.full_name, should_build: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
