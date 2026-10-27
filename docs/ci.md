# Continuous integration

Code reviews finish locally before a branch is pushed and its pull request opens.
GitHub runs builds and tests automatically when a pull request opens, reopens,
receives a commit, or becomes ready for review.

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

Windows also drives the MSI wizard through its final **Run Downpad** checkbox,
checks the installed files and registration, waits for the application window,
and uninstalls the test copy. After Next or Install, the driver clicks nothing
until that dialog closes, because its controls can disappear between a read and
a click, and the next dialog can appear before the old one closes. It still
checks every window for installer errors. `pnpm test` replays dialog sequences
through the driver's decisions on both platforms. A second scenario builds synthetic `0.0.1` and
`0.0.2-rc1` packages through the normal release-version and packaging steps, then
upgrades the stable installation to the candidate. This catches incorrect
numeric Windows executable versions even when the PR artifact uses `0.0.0`.
Fixtures use the application's release-version script from the PR head.
Older branches must include the numeric-version fix to pass these checks.

A recovery scenario removes only the executable from a registered `0.0.2-rc1`
test installation, then upgrades to `0.0.2-rc2`. Both packages have the same
numeric MSI version. The wizard must restore the intended files and launch the
app. This simulates the missing-executable state without recreating every step
of a historical failed upgrade.

The tests use isolated app profiles. Their packages stay under `dev-temp/` and
are never published. Each scenario runs in a separate PowerShell process with
an independent ten-minute deadline. Cleanup shares a two-minute wait budget
across products and retries. Timestamped progress records identify the last
operation if a native call stops returning. A supervisor timeout fails the test
and stops its process tree without terminating the shared Windows Installer
service. Forced termination can leave a test installation behind on the
disposable runner, so later installer scenarios do not run after a failure.

CI gives each scenario a twelve-minute outer limit and attempts to retain MSI
logs, progress records, and screenshots after success, failure, or cancellation.
The diagnostic artifact cannot be guaranteed if the runner itself stops
responding or the whole job is terminated.

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

Every push to `main` keeps its own build. Before building, the run tags its
commit as the next release candidate and builds that version. When both
platform builds succeed, it publishes the candidate as a GitHub prerelease.
Pushed version tags publish a candidate or a stable release after both platform
builds succeed. Pull request builds cannot publish releases. A regular manual
build must select `main` or a version tag. Its optional version override applies
only to that run, and manual builds publish nothing.

The release job verifies that the tag still points at the built commit and that
the commit belongs to the default branch. It publishes the AppImage, DEB, and MSI
installers from that run with a `SHA256SUMS` file. After a stable release, a
separate job marks the newest stable release as GitHub's latest release and
deletes the releases that the new release supersedes. Stable releases require an
explicit user request. [Releases](releasing.md) describes the policy.
