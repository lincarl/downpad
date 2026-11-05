import assert from "node:assert/strict";
import test from "node:test";
import { recoverWindowsBuild } from "./recover-windows-build.mjs";

const repository = "example/app";
const route = `/repos/${repository}/actions/runs/123`;
const retryRoute = `/repos/${repository}/actions/jobs/4/rerun`;

/** Model the cancelled build, with a client that rejects unexpected requests. */
function fixture(mode = "main") {
  const run = {
    id: 123, workflow_id: 456, path: ".github/workflows/build-installers.yml",
    head_sha: "a".repeat(40), head_branch: mode === "pr" ? "feature" : mode === "tag" ? "v1.2.3" : "main",
    event: mode === "pr" ? "pull_request" : "push", pull_requests: [],
    repository: { full_name: repository }, head_repository: { full_name: repository },
    run_attempt: 1, status: "completed", conclusion: "cancelled",
  };
  const data = {
    env: { GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: repository },
    event: { repository: { default_branch: "main" }, workflow_run: structuredClone(run) },
    run, runReads: 0, pullReads: 0, tagReads: 0, comparisonReads: 0, writes: [],
    pull: {
      number: 7, state: "open",
      head: { sha: run.head_sha, ref: run.head_branch, repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
    },
    tag: { sha: run.head_sha }, comparison: { status: "ahead" },
    jobs: ["Select build revision", "Tag release candidate", "Linux", "Windows", "GitHub Release"].map((name, index) => ({
      id: index + 1, name, status: "completed",
      conclusion: name === "Windows" ? "cancelled" : name === "GitHub Release" ? "skipped" : "success",
      check_run_url: `https://api.github.com/repos/${repository}/check-runs/${index + 1}`,
    })),
    annotations: [{ annotation_level: "failure", message: "The job has exceeded the maximum execution time of 45m0s" }],
  };
  data.pulls = [structuredClone(data.pull)];
  if (mode !== "main") data.jobs[1].conclusion = "skipped";
  if (mode === "pr") data.jobs.push({ name: "reviewed-ci", status: "completed", conclusion: "failure" });
  data.request = async (endpoint, options = {}) => {
    if (options.method) {
      assert.equal(options.method, "POST");
      assert.equal(endpoint, retryRoute);
      assert.equal(options.body, undefined);
      data.writes.push(endpoint);
      return undefined;
    }
    if (endpoint === route) {
      data.runReads++;
      return structuredClone(data.runReads > 1 && data.latestRun ? data.latestRun : data.run);
    }
    if (endpoint.startsWith(`/repos/${repository}/commits/${data.event.workflow_run.head_sha}/pulls?`)) {
      const page = Number(new URL(`https://api.github.com${endpoint}`).searchParams.get("page"));
      return data.pulls.slice((page - 1) * 100, page * 100);
    }
    if (endpoint === `/repos/${repository}/pulls/7`) {
      data.pullReads++;
      return structuredClone(data.pullReads > 1 && data.latestPull ? data.latestPull : data.pull);
    }
    if (endpoint === `/repos/${repository}/commits/${encodeURIComponent(`refs/tags/${data.event.workflow_run.head_branch}`)}`) {
      data.tagReads++;
      return structuredClone(data.tagReads > 1 && data.latestTag ? data.latestTag : data.tag);
    }
    if (endpoint === `/repos/${repository}/compare/${data.event.workflow_run.head_sha}...refs%2Fheads%2Fmain`) {
      data.comparisonReads++;
      return structuredClone(data.comparisonReads > 1 && data.latestComparison ? data.latestComparison : data.comparison);
    }
    if (endpoint.startsWith(`${route}/attempts/1/jobs?`)) {
      const page = Number(new URL(`https://api.github.com${endpoint}`).searchParams.get("page"));
      return { jobs: data.jobs.slice((page - 1) * 100, page * 100) };
    }
    if (endpoint.startsWith(`/repos/${repository}/check-runs/4/annotations?`)) {
      const page = Number(new URL(`https://api.github.com${endpoint}`).searchParams.get("page"));
      return data.annotations.slice((page - 1) * 100, page * 100);
    }
    throw new Error(`Unexpected API request ${endpoint}`);
  };
  return data;
}

test("a confirmed Windows job timeout retries only Windows and its dependants once", async () => {
  const data = fixture();
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /single automatic retry/);
  assert.equal(data.runReads, 2);
  assert.deepEqual(data.writes, [retryRoute]);

  // A duplicate webhook must observe the new attempt and make no second write.
  data.run = { ...data.run, run_attempt: 2, status: "queued", conclusion: null };
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
  assert.equal(data.writes.length, 1);
});

test("an open same-repository PR retries with its failed gate even when the run lists no PRs", async () => {
  for (const conclusion of ["cancelled", "timed_out", "failure"]) {
    const data = fixture("pr");
    data.run.conclusion = data.event.workflow_run.conclusion = conclusion;
    assert.deepEqual(data.event.workflow_run.pull_requests, []);
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /single automatic retry/);
    assert.equal(data.pullReads, 2);
    assert.equal(data.runReads, 2);
    assert.deepEqual(data.writes, [retryRoute]);
  }
});

test("stable and candidate tags retry only while their commit remains on main", async () => {
  for (const tag of ["v1.2.3", "v1.2.3-rc4"]) {
    for (const status of ["identical", "ahead"]) {
      const data = fixture("tag");
      data.run.head_branch = data.event.workflow_run.head_branch = tag;
      data.comparison.status = status;
      assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /single automatic retry/);
      assert.equal(data.tagReads, 2);
      assert.equal(data.comparisonReads, 2);
      assert.deepEqual(data.writes, [retryRoute]);
    }
  }
});

test("PR discovery, live state, and the final source check reject ineligible heads", async (t) => {
  const cases = [
    ["closed", (pr) => { pr.state = "closed"; }],
    ["stale commit", (pr) => { pr.head.sha = "b".repeat(40); }],
    ["changed branch", (pr) => { pr.head.ref = "other"; }],
    ["fork", (pr) => { pr.head.repo.full_name = "contributor/app"; }],
    ["foreign target", (pr) => { pr.base.repo.full_name = "other/app"; }],
    ["different base", (pr) => { pr.base.ref = "other"; }],
    ["invalid PR number", (pr) => { pr.number = "7/other"; }],
  ];
  for (const [name, modify] of cases) {
    for (const location of ["discovery", "live", "final"]) {
      await t.test(`${name} in ${location}`, async () => {
        const data = fixture("pr");
        data.latestPull = structuredClone(data.pull);
        modify(location === "discovery" ? data.pulls[0] : location === "live" ? data.pull : data.latestPull);
        assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
        assert.deepEqual(data.writes, []);
      });
    }
  }
});

test("missing PR associations fail closed while a current PR on a later page is accepted", async () => {
  const missing = fixture("pr");
  missing.pulls = [];
  assert.match(await recoverWindowsBuild(missing.event, missing.env, missing.request), /No current/);
  assert.deepEqual(missing.writes, []);
  const laterPage = fixture("pr");
  laterPage.pulls.unshift(...Array.from({ length: 100 }, () => ({ state: "closed" })));
  assert.match(await recoverWindowsBuild(laterPage.event, laterPage.env, laterPage.request), /single automatic retry/);
  assert.deepEqual(laterPage.writes, [retryRoute]);
});

test("moved tags and commits removed from main cannot retry, including during validation", async () => {
  for (const modify of [
    (data) => { data.tag.sha = "b".repeat(40); },
    (data) => { data.latestTag = { sha: "b".repeat(40) }; },
    (data) => { data.comparison.status = "behind"; },
    (data) => { data.comparison.status = "diverged"; },
    (data) => { data.latestComparison = { status: "diverged" }; },
  ]) {
    const data = fixture("tag");
    modify(data);
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.deepEqual(data.writes, []);
  }
});

test("ineligible or mismatched event and live run data cannot start a retry", async (t) => {
  const cases = [
    ["second attempt", { run_attempt: 2 }],
    ["manual dispatch", { event: "workflow_dispatch" }],
    ["pull request", { event: "pull_request" }],
    ["tag", { head_branch: "v1.2.3" }],
    ["feature branch", { head_branch: "feature" }],
    ["fork", { head_repository: { full_name: "contributor/app" } }],
    ["different repository", { repository: { full_name: "other/app" } }],
    ["different workflow", { path: ".github/workflows/other.yml" }],
    ["still running", { status: "in_progress" }],
    ["successful build", { conclusion: "success" }],
    ["neutral build", { conclusion: "neutral" }],
    ["invalid id", { id: "123/other" }],
    ["invalid workflow id", { workflow_id: 0 }],
    ["invalid commit", { head_sha: "abc" }],
  ];
  for (const [name, patch] of cases) {
    for (const location of ["event", "live"]) {
      await t.test(`${name} in ${location}`, async () => {
        const data = fixture();
        Object.assign(location === "event" ? data.event.workflow_run : data.run, patch);
        assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
        assert.deepEqual(data.writes, []);
      });
    }
  }
});

test("unsupported tag and arbitrary branch pushes never start recovery", async () => {
  for (const branch of ["feature", "v01.2.3", "v1.2.3-beta1", "v1.2.3-rc0"]) {
    const data = fixture("tag");
    data.run.head_branch = data.event.workflow_run.head_branch = branch;
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.deepEqual(data.writes, []);
  }
});

test("manual cancellation and unrelated error annotations do not restart a build", async () => {
  for (const annotations of [[],
    [{ annotation_level: "failure", message: "The operation was canceled." }],
    [{ annotation_level: "failure", message: "Process completed with exit code 1." }],
    [{ annotation_level: "warning", message: "The job has exceeded the maximum execution time of 45m0s" }],
  ]) {
    const data = fixture();
    data.annotations = annotations;
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /did not confirm/);
    assert.deepEqual(data.writes, []);
  }
});

test("failed tests, incomplete jobs, and missing prerequisite results remain blocked", async () => {
  for (const modify of [
    (data) => { data.jobs[3].conclusion = "failure"; },
    (data) => { data.jobs[2].conclusion = "failure"; },
    (data) => { data.jobs[2].conclusion = "cancelled"; },
    (data) => { data.jobs[1].conclusion = "skipped"; },
    (data) => { data.jobs[2].status = "in_progress"; },
    (data) => { data.jobs.splice(2, 1); },
    (data) => { data.jobs.push({ ...data.jobs[3] }); },
    (data) => { data.jobs[3].steps = [{ conclusion: "failure" }]; },
    (data) => { data.jobs[3].steps = [{ conclusion: "timed_out" }]; },
    (data) => { data.jobs[3].steps = [{ conclusion: "cancelled" }]; },
  ]) {
    const data = fixture();
    modify(data);
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.deepEqual(data.writes, []);
  }
});

test("only PR gates may fail, and non-main runs must skip candidate creation", async () => {
  for (const mode of ["main", "pr", "tag"]) {
    for (const modify of [
      (data) => { data.jobs[1].conclusion = mode === "main" ? "skipped" : "success"; },
      (data) => { data.jobs[2].conclusion = "failure"; },
      (data) => { data.jobs.push({ name: "Other test", status: "completed", conclusion: "failure" }); },
      (data) => {
        data.jobs.push({ name: "reviewed-ci", status: "completed", conclusion: mode === "pr" ? "cancelled" : "failure" });
      },
    ]) {
      const data = fixture(mode);
      modify(data);
      assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
      assert.deepEqual(data.writes, []);
    }
  }
});

test("a maintainer rerun or changed source between reads prevents a retry", async () => {
  for (const patch of [
    { run_attempt: 2, status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { workflow_id: 999 },
    { id: 321 },
    { event: "pull_request" },
    { head_branch: "v1.2.3" },
  ]) {
    const data = fixture();
    data.latestRun = { ...data.run, ...patch };
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.equal(data.runReads, 2);
    assert.deepEqual(data.writes, []);
  }
});

test("PR and tag retries also recheck attempts immediately before the write", async () => {
  for (const mode of ["pr", "tag"]) {
    const data = fixture(mode);
    data.latestRun = { ...data.run, run_attempt: 2, status: "in_progress" };
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.equal(data.runReads, 2);
    assert.deepEqual(data.writes, []);
  }
});

test("later pages cannot hide a failed job and can supply the timeout annotation", async () => {
  const data = fixture();
  while (data.jobs.length < 100) data.jobs.push({ name: "Other", status: "completed", conclusion: "success" });
  data.jobs.push({ name: "Failed test", status: "completed", conclusion: "failure" });
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /Another job failed/);
  assert.deepEqual(data.writes, []);
  data.jobs.pop();
  data.annotations.unshift(...Array.from({ length: 100 }, () => ({ annotation_level: "warning", message: "Other" })));
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /single automatic retry/);
  assert.equal(data.writes.length, 1);
});

test("missing or foreign check URLs and API failures fail closed", async () => {
  for (const checkUrl of [undefined, "https://other.example/4", `https://api.github.com/repos/${repository}/check-runs/4/other`]) {
    const data = fixture();
    data.jobs[3].check_run_url = checkUrl;
    await assert.rejects(recoverWindowsBuild(data.event, data.env, data.request), /valid check run URL/);
    assert.deepEqual(data.writes, []);
  }
  const data = fixture();
  await assert.rejects(recoverWindowsBuild(data.event, data.env, async () => { throw new Error("API unavailable"); }), /API unavailable/);
  assert.deepEqual(data.writes, []);
});

test("invalid Windows job IDs cannot enter the retry route", async () => {
  for (const id of [undefined, 0, -1, "4/other", Number.MAX_SAFE_INTEGER + 1]) {
    const data = fixture();
    data.jobs[3].id = id;
    await assert.rejects(recoverWindowsBuild(data.event, data.env, data.request), /valid job ID/);
    assert.deepEqual(data.writes, []);
  }
});
