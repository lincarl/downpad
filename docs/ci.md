# Reviewed CI

Regular pull requests receive CodeRabbit reviews before installer builds run. CodeRabbit uses its request changes workflow so a clean review also produces a submitted GitHub review tied to the commit. A pull request push starts only the small control job, which marks `reviewed-ci` pending and cancels an older build for that pull request. It does not install dependencies or build installers.

## Request a build

Read CodeRabbit's latest summary and inline findings, verify findings against the source, fix valid issues, and explain disagreements before resolving threads. Wait for CodeRabbit to finish reviewing the current head. A score, an old review, or a passing check without a submitted review is insufficient.

A push that keeps the pull request's changes the same, such as a rebase or a merge from main, also needs a new submitted review. GitHub moves CodeRabbit's approval onto the new head. CodeRabbit skips a push that adds no changes, and a full review that finds nothing does not submit a new approval while the moved one stands. Dismiss the moved approval, then ask for a full review.

```sh
gh api --paginate repos/OWNER/REPO/pulls/123/reviews \
  --jq '.[] | select(.user.login == "coderabbitai[bot]" and .state == "APPROVED" and .commit_id == "HEAD_SHA") | [.id, .submitted_at] | @tsv'
gh api --method PUT repos/OWNER/REPO/pulls/123/reviews/REVIEW_ID/dismissals \
  -f message="The branch was updated. A new review is needed." -f event=DISMISS
gh pr comment 123 --body "@coderabbitai full review"
```

Request CI explicitly for that immutable revision.

```sh
gh workflow run build-installers.yml --ref main \
  -f pr_number=123 \
  -f expected_sha=0123456789abcdef0123456789abcdef01234567
```

The gate requires a completed submitted review from `coderabbitai[bot]` with GitHub's `commit_id` equal to `expected_sha`, submitted after that commit was pushed to the pull request branch. GitHub rewrites an approval's `commit_id` when a push keeps the pull request's changes the same, so an approval from before the push may describe an earlier revision. The push time comes from the head branch's repository activity. Without it, the gate makes no decision. Blank submitted `COMMENTED` reviews from inline chat do not replace an earlier completed review and cannot satisfy the gate on their own. An `APPROVED` review may have an empty body. The gate rejects missing, dismissed, skipped, paused, failed, rate-limited, or unfinished reviews. Later pending or unsuccessful checks from the verified CodeRabbit app also block the request. Every review thread must be resolved, and no active review may request changes. If the repository requires an approving review, GitHub must report that requirement satisfied.

CI checks out the exact requested head with read-only permissions. PR requests must dispatch from a branch. A tag-selected dispatch with PR inputs fails before building or changing the app version. PR builds use the version committed in `package.json`. Version overrides remain available for main builds only. The control jobs use scripts from the default branch. They validate reviews again after Linux and Windows installer jobs finish, then publish the `reviewed-ci` status on that same immutable SHA. Changing the PR head prevents an older run from passing the new revision.

## Duplicate requests and retries

Requests for the same pull request serialize. A queued request reuses a prior successful run for the same revision after validating the current reviews and retained Linux and Windows installer evidence. It preserves the original successful run link.

A failed or unfinished attempt requires an explicit retry. Read its failure before requesting another run.

```sh
gh workflow run build-installers.yml --ref main \
  -f pr_number=123 \
  -f expected_sha=0123456789abcdef0123456789abcdef01234567 \
  -f retry=true
```

Installer evidence expires with the artifacts after 30 days. A revision without retained evidence needs a fresh explicit retry. Main pushes keep their automatic builds, and version tags keep the release workflow. Intermediate PR runs are cancelled, while main runs use separate concurrency groups so every main commit builds.

Regular dispatches may select the default branch or a release tag without PR inputs. Tag pushes and regular tag dispatches can publish a release only when the built commit and repository match the workflow's tag source. PR builds cannot publish releases.

## First installation

The existing installer workflow accepts dispatches from a selected branch. Before the default branch contains the gate script, an administrator or maintainer may explicitly dispatch the gate PR's own branch with `pr_number` and `expected_sha`. The workflow verifies that its source commit, the PR head, and `expected_sha` all match and that the PR belongs to this repository. It then performs the same real CodeRabbit review and installer checks.

This bootstrap path becomes unavailable as soon as the default branch contains the gate script. Later requests use trusted default-branch controls and should dispatch from `main`.

## Repository settings

The default branch requires a pull request, an up-to-date `reviewed-ci` status from GitHub Actions, and resolved review conversations, including for administrators. A completed `COMMENTED` bot review is acceptable when approving reviews are optional. Any stricter approval policy still applies.

Workflow artifacts and repository Actions logs are retained for 30 days. Do not publish a synthetic success status or bypass these requirements to merge a change.
