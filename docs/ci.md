# Continuous integration

Code reviews finish locally before a branch is pushed and its pull request opens.
GitHub runs builds and tests automatically when a pull request opens, reopens,
receives a commit, or becomes ready for review. Automatic GitHub CodeRabbit
reviews are disabled.

The required `reviewed-ci` Actions check passes only when source preparation and
both platform builds succeed. A failed, cancelled, or skipped build cannot pass
it. Merge only after this check passes on the current revision and every review
conversation is resolved. No GitHub reviewer result or manual CI request is
required for normal pull requests.

## Build revisions and retries

Pull requests build their immutable head commit, including fork contributions.
CI helpers and the Node version come from the workflow revision so older PR
branches do not need to contain those files. Build jobs check out these controls
under `dev-temp/workflow-controls`, keeping the application source and its pnpm
version pinned to the PR head.
Build jobs have read-only permissions and do not retain checkout credentials.
They run the application checks, tests, desktop build, desktop tests, and
installer packaging for Linux and Windows.

Builds use Ubuntu 26.04 and Windows Server 2025, the Node version in
`.node-version`, and the pnpm version in `package.json`. Jobs that use GitHub
CLI install the pinned release with checksum verification through
`scripts/install-github-cli.mjs`. The installation stays under `dev-temp`.

A new PR commit cancels obsolete builds for that pull request and replaces queued
intermediate revisions. A successful build of the same commit and application
version can supply retained installers to a repeated run. PR retries reuse only
successful builds from the same repository's PR branches. Main and release
builds reuse only successful default-branch push builds. Missing or expired
artifacts cause a fresh build. Artifacts remain available for 30 days.

Use GitHub Actions to rerun failed jobs after checking the failure. A maintainer
can also dispatch the workflow from the PR's current branch with `pr_number` and
`expected_sha`. The workflow rejects forks, tags, stale heads, version overrides,
and callers without the maintainer or administrator role on this manual path.
Normal automatic PR builds support forks.

## Migrating from the previous review gate

The previous workflow on `main` may leave a pending `reviewed-ci` commit status
while the new native Actions check passes. GitHub requires both results when
they have the same required name.

For this migration, first wait for the old control job and the automatic CI run
to finish. A maintainer then dispatches the new workflow from the PR branch using
its exact head commit.

```sh
gh workflow run build-installers.yml --ref YOUR_PR_BRANCH \
  -f pr_number=YOUR_PR_NUMBER \
  -f expected_sha=YOUR_PR_HEAD_SHA
```

This run checks the same revision and can reuse its successful PR build. It
replaces the old commit status only with the real CI result, after verifying that
the PR head still matches. Once `main` no longer contains the old review-gate
script, the compatibility step publishes no legacy status. The native
`reviewed-ci` check supplies the merge requirement.

## Main builds and releases

Every push to `main` keeps its own build. Version tags retain the existing release
workflow and publish only after both platform builds succeed. Pull request
builds cannot publish releases. A regular manual build must select `main` or a
version tag; its optional version override applies only to that run.

The release job verifies that the tag still points at the built commit and that
the commit belongs to the default branch. It publishes the AppImage, DEB, and MSI
installers from that run. Stable releases require an explicit user request.
