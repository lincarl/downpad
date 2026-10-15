import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REVIEW_BOTS, readPullRequest, selectPreviousAttempt, validateDispatchRef, validateReviewGate } from "./reviewed-ci.mjs";

const sha = "a".repeat(40);

test("allows PR requests on branch refs and rejects selected tags before any GitHub request", () => {
  for (const ref of ["refs/heads/main", "refs/heads/reviewed-feature"]) {
    assert.doesNotThrow(() => validateDispatchRef(ref, "1", "main"));
  }
  for (const ref of ["refs/tags/v1.2.3", "refs/pull/1/merge", undefined]) {
    assert.throws(() => validateDispatchRef(ref, "1", "main"), /dispatch from a branch/);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./reviewed-ci.mjs", import.meta.url)), "request"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "example/app",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/tags/v1.2.3",
      PR_NUMBER: "1",
      EXPECTED_SHA: sha,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PR builds must dispatch from a branch, not a tag/);
  assert.equal(result.stdout, "");
});

test("preserves regular default-branch and tag dispatches while requiring inputs for other branches", () => {
  for (const ref of ["refs/heads/main", "refs/tags/v1.2.3"]) {
    assert.doesNotThrow(() => validateDispatchRef(ref, undefined, "main"));
  }
  for (const ref of ["refs/heads/reviewed-feature", "refs/pull/1/merge", undefined]) {
    assert.throws(() => validateDispatchRef(ref, undefined, "main"), /require pr_number and expected_sha/);
  }
});

function fixture() {
  return {
    pr: { state: "open", draft: false, head: { sha, ref: "feature/x", repo: { full_name: "example/app" } }, reviewDecision: null },
    reviews: REVIEW_BOTS.map((login, index) => ({ id: index + 1, user: { login, type: "Bot" }, commit_id: sha, state: "COMMENTED", submitted_at: "2026-10-13T12:00:00Z", body: "Review completed. No actionable findings." })),
    threads: [],
  };
}
// The fixture's head was pushed an hour before its reviews.
const pushedAt = "2026-10-13T11:00:00Z";
function problems(data, signals) {
  return validateReviewGate(data.pr, data.reviews, data.threads, sha, REVIEW_BOTS, { headPushedAt: pushedAt, ...signals });
}

test("accepts a completed exact-head CodeRabbit review when no approval policy requires APPROVED", () => {
  assert.deepEqual(problems(fixture()), []);
});

test("accepts a submitted exact-head APPROVED review without a body but rejects empty COMMENTED reviews", () => {
  for (const body of ["", null, undefined]) {
    const data = fixture();
    data.reviews[0] = { ...data.reviews[0], state: "APPROVED", body };
    assert.deepEqual(problems(data), []);
    data.reviews[0].state = "COMMENTED";
    assert.match(problems(data).join("\n"), /not submitted a completed review/);
  }
  const data = fixture();
  data.reviews[0].state = "APPROVED";
  data.reviews[0].body = "Review skipped";
  assert.match(problems(data).join("\n"), /incomplete/);
  data.reviews[0].body = "";
  data.reviews[0].commit_id = "b".repeat(40);
  assert.match(problems(data).join("\n"), /not submitted a completed review/);
});

test("ignores later blank submitted chat reviews after a real APPROVED or COMMENTED review", () => {
  for (const state of ["APPROVED", "COMMENTED"]) {
    for (const body of ["", null, undefined, " \n "]) {
      const data = fixture();
      data.reviews[0].state = state;
      if (state === "APPROVED") {
        data.pr.reviewDecision = "APPROVED";
        data.reviews[0].body = "";
      }
      data.reviews.push({ ...data.reviews[0], id: 10, state: "COMMENTED", submitted_at: "2026-10-13T13:00:00Z", body });
      assert.deepEqual(problems(data), []);
    }
  }
});

test("blank chat alone cannot satisfy review requirements or hide a later pending, dismissed, or negative review", () => {
  const chatOnly = fixture();
  chatOnly.reviews[0].body = "";
  chatOnly.reviews.push({ ...chatOnly.reviews[0], id: 10 });
  assert.match(problems(chatOnly).join("\n"), /not submitted a completed review/);

  for (const state of ["PENDING", "DISMISSED", "CHANGES_REQUESTED", "COMMENTED"]) {
    const data = fixture();
    data.reviews[0].state = "APPROVED";
    data.reviews.push({ ...data.reviews[0], id: 10, state, body: "", submitted_at: ["PENDING", "COMMENTED"].includes(state) ? null : "2026-10-13T13:00:00Z" });
    data.reviews.push({ ...data.reviews[0], id: 11, state: "COMMENTED", body: "", submitted_at: "2026-10-13T14:00:00Z" });
    assert.match(problems(data).join("\n"), /not submitted a completed review/);
  }
});

test("rejects a missing CodeRabbit review, stale review, or non-bot identity", () => {
  const data = fixture();
  data.reviews.pop();
  assert.match(problems(data).join("\n"), /coderabbitai/);
  data.reviews = fixture().reviews;
  data.reviews[0].commit_id = "b".repeat(40);
  assert.match(problems(data).join("\n"), /coderabbitai/);
  data.reviews = fixture().reviews;
  data.reviews[0].user.type = "User";
  assert.match(problems(data).join("\n"), /coderabbitai/);
});

test("rejects changed heads, unresolved threads, and an active approval requirement", () => {
  const data = fixture();
  data.pr.head.sha = "b".repeat(40);
  data.pr.reviewDecision = "REVIEW_REQUIRED";
  data.threads.push({ isResolved: false });
  const result = problems(data).join("\n");
  assert.match(result, /head changed/);
  assert.match(result, /approving review/);
  assert.match(result, /every review thread/);
});

test("rejects a pull request that has closed or returned to draft", () => {
  const data = fixture();
  data.pr.state = "closed";
  assert.match(problems(data).join("\n"), /must be open/);
  data.pr.state = "open";
  data.pr.draft = true;
  assert.match(problems(data).join("\n"), /still a draft/);
});

test("does not treat COMMENTED as clearing an earlier request for changes", () => {
  const data = fixture();
  data.reviews.unshift({ id: 0, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-12T12:00:00Z" });
  data.reviews.push({ id: 4, user: { login: "reviewer" }, state: "COMMENTED", submitted_at: "2026-10-13T13:00:00Z" });
  assert.match(problems(data).join("\n"), /active review/);
  data.reviews.push({ id: 5, user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-10-13T14:00:00Z" });
  assert.deepEqual(problems(data), []);
});

test("rejects a bot's latest skipped, paused, failed, pending, or rate-limited review", () => {
  for (const body of ["Review skipped", "Review is paused", "Review failed", "Review in progress", "## Rate limit exceeded"]) {
    const data = fixture();
    data.reviews.push({ ...data.reviews[0], id: 10, body });
    assert.match(problems(data).join("\n"), /incomplete/);
  }
  const data = fixture();
  data.reviews.push({ ...data.reviews[0], id: 10, state: "PENDING", submitted_at: null });
  assert.match(problems(data).join("\n"), /not submitted/);
});

test("rejects later unsuccessful bot checks and comments even after a completed review", () => {
  const data = fixture();
  for (const conclusion of [null, "failure", "cancelled", "skipped", "neutral"]) {
    assert.match(problems(data, {
      checkRuns: [{ id: 10, name: "CodeRabbit", app: { id: 347564 }, status: conclusion ? "completed" : "in_progress", conclusion }],
    }).join("\n"), /check has not completed/);
  }
  assert.match(problems(data, {
    comments: [{ user: { login: REVIEW_BOTS[0], type: "Bot" }, updated_at: "2026-10-13T13:00:00Z", body: "Review is paused" }],
  }).join("\n"), /latest comment/);
  assert.deepEqual(problems(data, {
    checkRuns: [{ id: 10, name: "CodeRabbit", app: { id: 347564 }, status: "completed", conclusion: "success" }],
  }), []);
});

test("counts a review of the head only when it was submitted after the head was pushed", () => {
  // GitHub moves an approval onto a new head when the push keeps the changes.
  const moved = fixture();
  moved.reviews[0] = { ...moved.reviews[0], state: "APPROVED", body: "" };
  for (const headPushedAt of ["2026-10-13T12:30:00Z", "2026-10-13T12:00:00Z"]) {
    assert.match(problems(moved, { headPushedAt }).join("\n"), /submitted before that commit was pushed/);
  }
  assert.deepEqual(problems(moved, { headPushedAt: "2026-10-13T11:59:59Z" }), []);
  assert.match(problems(moved, { headPushedAt: undefined }).join("\n"), /not reported when the head was pushed/);

  const reviewedAgain = fixture();
  reviewedAgain.reviews.push({ ...reviewedAgain.reviews[0], id: 10, submitted_at: "2026-10-13T13:00:00Z" });
  assert.deepEqual(problems(reviewedAgain, { headPushedAt: "2026-10-13T12:30:00Z" }), []);
});

test("waiting statuses do not erase failure and retry history", () => {
  const failure = { context: "reviewed-ci", creator: { login: "github-actions[bot]" }, state: "failure" };
  const waiting = { ...failure, state: "pending", description: "Waiting for CodeRabbit review" };
  assert.equal(selectPreviousAttempt([waiting, failure]), failure);
  assert.equal(selectPreviousAttempt([{ ...failure, creator: { login: "another-bot" } }]), undefined);
});

function collectionClient(heads) {
  const routes = [];
  let headRead = 0;
  return {
    routes,
    request: async (route) => {
      routes.push(route);
      if (route === "/repos/example/app/pulls/1") return { ...fixture().pr, head: { ...fixture().pr.head, sha: heads[headRead++] } };
      if (route.includes("/activity?")) return [{ activity_type: "push", after: sha, timestamp: pushedAt }];
      if (route === "/graphql") return { data: { repository: { pullRequest: { headRefOid: sha, reviewDecision: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
      if (route.includes("/reviews?")) return fixture().reviews;
      if (route.includes("/check-runs?")) return { check_runs: [] };
      if (route.includes("/statuses?") || route.includes("/comments?")) return [];
      throw new Error(`Unexpected route ${route}`);
    },
  };
}

test("rejects a different initial head even when it would transition to the requested SHA", async () => {
  const client = collectionClient(["b".repeat(40), sha]);
  await assert.rejects(readPullRequest("example/app", "1", sha, client.request), /head changed/);
  assert.deepEqual(client.routes, ["/repos/example/app/pulls/1"]);
});

test("pins evidence to the requested SHA and rejects a head change during collection", async () => {
  const client = collectionClient([sha, "b".repeat(40)]);
  const data = await readPullRequest("example/app", "1", sha, client.request);
  assert.match(problems(data, data.signals).join("\n"), /head changed/);
  const commitRoutes = client.routes.filter((route) => route.includes("/commits/"));
  assert.equal(commitRoutes.length, 2);
  assert.ok(commitRoutes.every((route) => route.includes(`/commits/${sha}/`)));
});

test("refreshes unchanged-head review decisions and threads added while signals are collected", async () => {
  const client = collectionClient([sha, sha]);
  let updatedDuringSignals = false;
  const request = async (route, options) => {
    if (route.includes("/reviews?")) updatedDuringSignals = true;
    if (route === "/graphql") {
      assert.match(options.body.query, /headRefOid/);
      return { data: { repository: { pullRequest: {
        headRefOid: sha,
        reviewDecision: updatedDuringSignals ? "REVIEW_REQUIRED" : null,
        reviewThreads: { nodes: updatedDuringSignals ? [{ isResolved: false }] : [], pageInfo: { hasNextPage: false } },
      } } } };
    }
    return client.request(route, options);
  };
  const data = await readPullRequest("example/app", "1", sha, request);
  const result = problems(data, data.signals).join("\n");
  assert.match(result, /approving review/);
  assert.match(result, /every review thread/);
  assert.equal(data.pr.head.sha, sha);
});

test("rejects a changed GraphQL head even if the next REST snapshot would return to the requested SHA", async () => {
  const client = collectionClient([sha, sha]);
  let changedDuringSignals = false;
  const request = async (route, options) => {
    if (route.includes("/statuses?")) changedDuringSignals = true;
    if (route === "/graphql") {
      return { data: { repository: { pullRequest: {
        headRefOid: changedDuringSignals ? "b".repeat(40) : sha,
        reviewDecision: null,
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      } } } };
    }
    return client.request(route, options);
  };
  await assert.rejects(readPullRequest("example/app", "1", sha, request), /head changed/);
});


test("reads the head's push time from its branch activity and fails closed without it", async () => {
  const read = (activity, head = fixture().pr.head) => {
    const client = collectionClient([sha, sha]);
    const routes = [];
    const request = async (route, options) => {
      routes.push(route);
      if (route.includes("/activity?")) return activity;
      if (route === "/repos/example/app/pulls/1") return { ...(await client.request(route, options)), head };
      return client.request(route, options);
    };
    return { routes, data: readPullRequest("example/app", "1", sha, request) };
  };
  const newest = { activity_type: "force_push", after: sha, timestamp: "2026-10-13T12:30:00Z" };
  const older = { activity_type: "push", after: sha, timestamp: "2026-10-13T10:00:00Z" };
  const fork = { sha, ref: "fix#1", repo: { full_name: "someone/app" } };
  const { routes, data } = read([newest, { activity_type: "push", after: "b".repeat(40), timestamp: "2026-10-13T12:00:00Z" }, older], fork);
  assert.equal((await data).signals.headPushedAt, "2026-10-13T12:30:00Z");
  assert.ok(routes.includes("/repos/someone/app/activity?ref=refs%2Fheads%2Ffix%231&per_page=100"));
  assert.match(problems(await data, (await data).signals).join("\n"), /submitted before that commit was pushed/);
  await assert.rejects(read([{ ...newest, after: "b".repeat(40) }]).data, /no record of the push/);
  await assert.rejects(read([newest], { sha, ref: "x", repo: null }).data, /head repository is unavailable/);
});
