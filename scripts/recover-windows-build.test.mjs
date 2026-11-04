import assert from "node:assert/strict";
import test from "node:test";
import { recoverWindowsBuild } from "./recover-windows-build.mjs";

const repository = "example/app";
const route = `/repos/${repository}/actions/runs/123`;

/** Model the cancelled build, with a client that rejects unexpected requests. */
function fixture() {
  const run = {
    id: 123, workflow_id: 456, path: ".github/workflows/build-installers.yml",
    head_sha: "a".repeat(40), head_branch: "main", event: "push",
    repository: { full_name: repository }, head_repository: { full_name: repository },
    run_attempt: 1, status: "completed", conclusion: "cancelled",
  };
  const data = {
    env: { GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: repository },
    event: { repository: { default_branch: "main" }, workflow_run: structuredClone(run) },
    run, runReads: 0, writes: [],
    jobs: ["Select build revision", "Tag release candidate", "Linux", "Windows", "GitHub Release"].map((name, index) => ({
      id: index + 1, name, status: "completed",
      conclusion: name === "Windows" ? "cancelled" : name === "GitHub Release" ? "skipped" : "success",
      check_run_url: `https://api.github.com/repos/${repository}/check-runs/${index + 1}`,
    })),
    annotations: [{ annotation_level: "failure", message: "The job has exceeded the maximum execution time of 45m0s" }],
  };
  data.request = async (endpoint, options = {}) => {
    if (options.method) {
      assert.equal(options.method, "POST");
      assert.equal(endpoint, `${route}/rerun-failed-jobs`);
      assert.equal(options.body, undefined);
      data.writes.push(endpoint);
      return undefined;
    }
    if (endpoint === route) {
      data.runReads++;
      return structuredClone(data.runReads > 1 && data.latestRun ? data.latestRun : data.run);
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

test("a confirmed Windows job timeout requests one retry of failed jobs and their dependants", async () => {
  const data = fixture();
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /single automatic retry/);
  assert.equal(data.runReads, 2);
  assert.deepEqual(data.writes, [`${route}/rerun-failed-jobs`]);

  // A duplicate webhook must observe the new attempt and make no second write.
  data.run = { ...data.run, run_attempt: 2, status: "queued", conclusion: null };
  assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
  assert.equal(data.writes.length, 1);
});

test("ineligible event and live run data cannot start a retry", async (t) => {
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
    ["failed build", { conclusion: "failure" }],
    ["invalid id", { id: "123/other" }],
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
  ]) {
    const data = fixture();
    modify(data);
    assert.match(await recoverWindowsBuild(data.event, data.env, data.request), /No retry/);
    assert.deepEqual(data.writes, []);
  }
});

test("a maintainer rerun or changed source between reads prevents a retry", async () => {
  for (const patch of [
    { run_attempt: 2, status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { workflow_id: 999 },
    { id: 321 },
  ]) {
    const data = fixture();
    data.latestRun = { ...data.run, ...patch };
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
