import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_BOTS, selectPreviousAttempt, validateReviewGate } from "./reviewed-ci.mjs";

const sha = "a".repeat(40);
function fixture() {
  return {
    pr: { state: "open", draft: false, head: { sha }, reviewDecision: null },
    reviews: REVIEW_BOTS.map((login, index) => ({ id: index + 1, user: { login, type: "Bot" }, commit_id: sha, state: "COMMENTED", submitted_at: "2026-10-13T12:00:00Z", body: "Review completed. No actionable findings." })),
    threads: [],
  };
}
function problems(data, signals) {
  return validateReviewGate(data.pr, data.reviews, data.threads, sha, REVIEW_BOTS, signals);
}

test("accepts completed exact-head bot reviews when no approval policy requires APPROVED", () => {
  assert.deepEqual(problems(fixture()), []);
});

test("rejects a missing bot, stale review, or non-bot identity", () => {
  const data = fixture();
  data.reviews.pop();
  assert.match(problems(data).join("\n"), /greptile-apps/);
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
    comments: [{ user: { login: REVIEW_BOTS[1], type: "Bot" }, updated_at: "2026-10-13T13:00:00Z", body: "Review is paused" }],
  }).join("\n"), /latest comment/);
  assert.deepEqual(problems(data, {
    checkRuns: [{ id: 10, name: "CodeRabbit", app: { id: 347564 }, status: "completed", conclusion: "success" }],
  }), []);
});

test("waiting statuses do not erase failure and retry history", () => {
  const failure = { context: "reviewed-ci", creator: { login: "github-actions[bot]" }, state: "failure" };
  const waiting = { ...failure, state: "pending", description: "Waiting for both bot reviews" };
  assert.equal(selectPreviousAttempt([waiting, failure]), failure);
  assert.equal(selectPreviousAttempt([{ ...failure, creator: { login: "another-bot" } }]), undefined);
});
