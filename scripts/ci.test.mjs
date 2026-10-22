import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGitHubClient, finish, prepare } from "./ci.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repository = "example/app";
const helper = fileURLToPath(new URL("./ci.mjs", import.meta.url));

/** Provide a manual PR run and a client that rejects unexpected API requests. */
function fixture() {
  const data = {
    env: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/heads/feature/ci",
      GITHUB_SHA: sha,
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ID: "1234",
      CI_PREPARE_RESULT: "success",
      CI_BUILD_RESULT: "success",
      CI_GATE_RESULT: "success",
    },
    event: {
      repository: { default_branch: "main" },
      inputs: { pr_number: "7", expected_sha: sha, version: "" },
    },
    pr: { number: 7, state: "open", head: { sha, ref: "feature/ci", repo: { full_name: repository } } },
    permission: { role_name: "maintain", permission: "write" },
    calls: [],
    statuses: [],
    pullReads: 0,
  };
  data.request = async (route, options = {}) => {
    data.calls.push({ route, ...options });
    if (route === `/repos/${repository}/collaborators/maintainer/permission`) return data.permission;
    if (route === `/repos/${repository}/pulls/7`) {
      data.pullReads++;
      return structuredClone(data.pullReads > 1 && data.latestPr ? data.latestPr : data.pr);
    }
    if (route === `/repos/${repository}/contents/scripts/reviewed-ci.mjs?ref=${encodeURIComponent(data.event.repository.default_branch)}`) {
      if (data.legacyError) throw data.legacyError;
      return { type: "file" };
    }
    if (route === `/repos/${repository}/statuses/${sha}` && options.method === "POST") {
      data.statuses.push(options.body);
      return {};
    }
    throw new Error(`Unexpected API request ${route}`);
  };
  return data;
}

test("pull_request selects the exact event head and fork source without any API calls", async () => {
  const data = fixture();
  data.env.GITHUB_EVENT_NAME = "pull_request";
  data.env.GITHUB_SHA = otherSha;
  data.env.GITHUB_REF = "refs/pull/7/merge";
  data.pr.head.repo.full_name = "contributor/app";
  data.event.pull_request = data.pr;
  assert.deepEqual(await prepare(data.event, data.env, data.request), {
    mode: "pr",
    head_sha: sha,
    head_repository: "contributor/app",
    head_branch: "feature/ci",
    default_branch: "main",
    pr_number: "7",
  });
  assert.deepEqual(data.calls, []);
});

test("push and regular dispatch retain their branch or tag revision and allow version inputs", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const ref of ["refs/heads/trunk", "refs/tags/v1.2.3"]) {
      const data = fixture();
      data.env.GITHUB_EVENT_NAME = eventName;
      data.env.GITHUB_REF = ref;
      data.event.repository.default_branch = "trunk";
      data.event.inputs = { version: "1.2.4" };
      assert.deepEqual(await prepare(data.event, data.env, data.request), {
        mode: "regular",
        head_sha: sha,
        head_repository: repository,
        head_branch: ref.replace(/^refs\/(heads|tags)\//, ""),
        default_branch: "trunk",
        pr_number: "",
      });
      assert.equal(data.event.inputs.version, "1.2.4");
      assert.deepEqual(data.calls, []);
    }
  }
});

test("non-default manual branches require both PR inputs", async () => {
  for (const inputs of [{}, { expected_sha: sha }, { pr_number: "7" }]) {
    const data = fixture();
    data.event.inputs = inputs;
    await assert.rejects(prepare(data.event, data.env, data.request));
    assert.deepEqual(data.calls, []);
  }
});

test("manual PR preparation permits only admin and maintain roles and stays read-only", async () => {
  for (const permission of [{ role_name: "admin" }, { role_name: "maintain", permission: "write" }, { permission: "admin" }]) {
    const data = fixture();
    data.permission = permission;
    assert.deepEqual(await prepare(data.event, data.env, data.request), {
      mode: "pr",
      head_sha: sha,
      head_repository: repository,
      head_branch: "feature/ci",
      default_branch: "main",
      pr_number: "7",
    });
    assert.deepEqual(data.calls.map(({ route }) => route), [
      `/repos/${repository}/collaborators/maintainer/permission`,
      `/repos/${repository}/pulls/7`,
    ]);
    assert.ok(data.calls.every((call) => !call.method || call.method === "GET"));
  }
  for (const role of ["write", "read", "triage", "none", "custom", undefined]) {
    const data = fixture();
    data.permission = { role_name: role, permission: "write" };
    await assert.rejects(prepare(data.event, data.env, data.request), /admin or maintain/);
    assert.equal(data.pullReads, 0);
    assert.deepEqual(data.statuses, []);
  }
});

test("manual PR runs reject invalid revisions, refs, actors, and version overrides", async (t) => {
  const cases = [
    ["selected tag", (data) => { data.env.GITHUB_REF = "refs/tags/v1.2.3"; }, /branch, not a tag/],
    ["merge ref", (data) => { data.env.GITHUB_REF = "refs/pull/7/merge"; }, /branch, not a tag/],
    ["workflow SHA differs", (data) => { data.env.GITHUB_SHA = otherSha; }, /workflow GITHUB_SHA/],
    ["short expected SHA", (data) => { data.event.inputs.expected_sha = "abc123"; }, /40-character/],
    ["uppercase expected SHA", (data) => { data.event.inputs.expected_sha = sha.toUpperCase(); }, /40-character/],
    ["invalid PR number", (data) => { data.event.inputs.pr_number = "-7"; }, /positive integer/],
    ["missing actor", (data) => { delete data.env.GITHUB_ACTOR; }, /GITHUB_ACTOR/],
    ["invalid actor", (data) => { data.env.GITHUB_ACTOR = "bad/name"; }, /GITHUB_ACTOR/],
    ["version override", (data) => { data.event.inputs.version = "1.2.3"; }, /cannot override/],
    ["blank version override", (data) => { data.event.inputs.version = " "; }, /cannot override/],
    ["different current head", (data) => { data.pr.head.sha = otherSha; }, /head changed/],
    ["closed PR", (data) => { data.pr.state = "closed"; }, /must be open/],
    ["fork PR", (data) => { data.pr.head.repo.full_name = "contributor/app"; }, /same-repository/],
    ["deleted head repository", (data) => { data.pr.head.repo = null; }, /same-repository/],
    ["different branch at the same SHA", (data) => { data.env.GITHUB_REF = "refs/heads/main"; }, /head branch/],
  ];
  for (const [name, modify, error] of cases) {
    await t.test(name, async () => {
      const data = fixture();
      modify(data);
      await assert.rejects(prepare(data.event, data.env, data.request), error);
      assert.deepEqual(data.statuses, []);
    });
  }
});

test("finish publishes legacy success only for the revalidated head and all successful jobs", async () => {
  const data = fixture();
  data.event.repository.default_branch = "release/main";
  await finish(data.event, data.env, data.request);
  assert.equal(data.pullReads, 2);
  assert.deepEqual(data.calls.slice(-3).map(({ route }) => route), [
    `/repos/${repository}/contents/scripts/reviewed-ci.mjs?ref=release%2Fmain`,
    `/repos/${repository}/pulls/7`,
    `/repos/${repository}/statuses/${sha}`,
  ]);
  assert.deepEqual(data.statuses, [{
    context: "reviewed-ci",
    state: "success",
    description: "Installer CI passed for the current pull request head.",
    target_url: `https://github.com/${repository}/actions/runs/1234`,
  }]);
});

test("failed, cancelled, skipped, or missing dependencies never produce a successful status", async (t) => {
  for (const dependency of ["CI_PREPARE_RESULT", "CI_BUILD_RESULT", "CI_GATE_RESULT"]) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      await t.test(`${dependency}=${result}`, async () => {
        const data = fixture();
        data.env[dependency] = result;
        await assert.rejects(finish(data.event, data.env, data.request), /must all succeed/);
        assert.equal(data.statuses.length, 1);
        assert.equal(data.statuses[0].state, "failure");
        assert.equal(data.statuses[0].target_url, `https://github.com/${repository}/actions/runs/1234`);
      });
    }
  }
});

test("finish never publishes when the default branch no longer has the old gate", async () => {
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const data = fixture();
    data.legacyError = Object.assign(new Error("Not found"), { status: 404 });
    data.env.CI_BUILD_RESULT = result;
    if (result === "success") await finish(data.event, data.env, data.request);
    else await assert.rejects(finish(data.event, data.env, data.request), /must all succeed/);
    assert.equal(data.pullReads, 2);
    assert.deepEqual(data.statuses, []);
  }
});

test("legacy gate API errors fail closed instead of treating errors as a missing gate", async () => {
  for (const status of [401, 403, 429, 500, undefined]) {
    const data = fixture();
    data.legacyError = Object.assign(new Error("Probe failed"), { status });
    await assert.rejects(finish(data.event, data.env, data.request), /Probe failed/);
    assert.deepEqual(data.statuses, []);
  }
});

test("finish rejects stale or closed heads both before and after the default-branch probe", async (t) => {
  for (const timing of ["initial", "after probe"]) {
    for (const change of ["sha", "state", "repository", "branch"]) {
      await t.test(`${change} changed ${timing}`, async () => {
        const data = fixture();
        const changed = structuredClone(data.pr);
        if (change === "sha") changed.head.sha = otherSha;
        if (change === "state") changed.state = "closed";
        if (change === "repository") changed.head.repo.full_name = "contributor/app";
        if (change === "branch") changed.head.ref = "different-branch";
        if (timing === "initial") data.pr = changed;
        else data.latestPr = changed;
        await assert.rejects(finish(data.event, data.env, data.request));
        assert.deepEqual(data.statuses, []);
      });
    }
  }
});

test("finish reapplies dispatch authorization and rejects non-manual PR runs", async () => {
  const variants = [
    (data) => { data.env.GITHUB_EVENT_NAME = "pull_request"; data.event.pull_request = data.pr; },
    (data) => { data.env.GITHUB_EVENT_NAME = "push"; },
    (data) => { data.event.inputs = {}; data.env.GITHUB_REF = "refs/heads/main"; },
    (data) => { data.permission.role_name = "write"; },
    (data) => { data.env.GITHUB_SHA = otherSha; },
    (data) => { data.env.GITHUB_REF = "refs/tags/v1.2.3"; },
    (data) => { data.env.GITHUB_REF = "refs/heads/main"; },
    (data) => { data.event.inputs.version = "1.2.3"; },
  ];
  for (const modify of variants) {
    const data = fixture();
    modify(data);
    await assert.rejects(finish(data.event, data.env, data.request));
    assert.deepEqual(data.statuses, []);
  }
});

test("permission and status publication failures propagate without a false success", async () => {
  const data = fixture();
  await assert.rejects(finish(data.event, data.env, async () => { throw new Error("Permission lookup failed"); }), /Permission lookup failed/);
  assert.deepEqual(data.statuses, []);
  await assert.rejects(finish(data.event, data.env, (route, options) => {
    if (options?.method === "POST") throw new Error("Status publication failed");
    return data.request(route, options);
  }), /Status publication failed/);
  assert.deepEqual(data.statuses, []);
  delete data.env.GITHUB_RUN_ID;
  await assert.rejects(finish(data.event, data.env, data.request), /GITHUB_RUN_ID/);
  assert.deepEqual(data.statuses, []);
});

test("GitHub transport preserves HTTP errors, requires GH_TOKEN, and encodes status writes", async () => {
  const calls = [];
  const request = createGitHubClient({ GH_TOKEN: "test-token" }, async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  });
  assert.deepEqual(await request(`/repos/${repository}/statuses/${sha}`, { method: "POST", body: { state: "failure" } }), { id: 1 });
  assert.equal(calls[0].url, `https://api.github.com/repos/${repository}/statuses/${sha}`);
  assert.equal(calls[0].headers.authorization, "Bearer test-token");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { state: "failure" });
  for (const status of [404, 403, 500]) {
    const failed = createGitHubClient({ GH_TOKEN: "test-token" }, async () => new Response("error", { status }));
    await assert.rejects(failed("/probe"), (error) => error.status === status);
  }
  const missingToken = createGitHubClient({}, async () => { throw new Error("Unexpected fetch"); });
  await assert.rejects(missingToken("/probe"), /GH_TOKEN is required/);
});

test("prepare CLI reads the runner event and writes the same outputs to stdout or GITHUB_OUTPUT", async (t) => {
  const scratch = path.resolve("dev-temp/ci-review-flow/helper");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventFile = path.join(directory, "event.json");
  const outputFile = path.join(directory, "output.txt");
  const data = fixture();
  data.event.pull_request = data.pr;
  await writeFile(eventFile, JSON.stringify(data.event));
  const env = {
    ...process.env,
    ...data.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_SHA: otherSha,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_OUTPUT: "",
    GH_TOKEN: "",
  };
  const expected = `mode=pr\nhead_sha=${sha}\nhead_repository=${repository}\nhead_branch=feature/ci\ndefault_branch=main\npr_number=7\n`;
  const stdout = spawnSync(process.execPath, [helper, "prepare"], { encoding: "utf8", env });
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.equal(stdout.stdout, expected);
  await writeFile(outputFile, "existing=value\n");
  const output = spawnSync(process.execPath, [helper, "prepare"], { encoding: "utf8", env: { ...env, GITHUB_OUTPUT: outputFile } });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, "");
  assert.equal(await readFile(outputFile, "utf8"), `existing=value\n${expected}`);
  const invalid = spawnSync(process.execPath, [helper, "request"], { encoding: "utf8", env });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected prepare or finish/);
  assert.equal(invalid.stdout, "");
});
