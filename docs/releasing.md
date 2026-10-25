# Releases

Every successful push to `main` publishes a release candidate. Its tag has the
form `vMAJOR.MINOR.PATCH-rcN`, and its GitHub prerelease carries the Windows MSI
installer, the Linux AppImage and DEB package, and a `SHA256SUMS` file.
Candidates keep the same target version, as `rc1`, `rc2` and so on, until that
version is released as stable. For example, `v0.3.5-rc1` and `v0.3.5-rc2` both
lead to the stable release `v0.3.5`.

## Release candidates

Before the builds of a main push, the installer workflow creates the annotated
tag of the next candidate on the pushed commit, and both builds use its version.
When both builds and their tests pass, the release job publishes the candidate
as a prerelease. A failed build publishes nothing and leaves its tag unused, so
the next main push takes the next number. Pull requests and other branches never
publish.

The next candidate targets the patch after the newest stable tag. When a
candidate for a higher version already exists, such as a hand-pushed
`v0.4.0-rc1`, later candidates continue that version. Every version tag counts as
taken, also one without a release. A rerun of a workflow run reuses the tag that
the run created, as long as the tag still points to the run's commit, also after
a stable release of its version. Concurrent runs take distinct numbers.

To start a new minor or major version, push its first candidate tag by hand on a
`main` commit whose CI passed. A pushed candidate tag publishes a prerelease like
the automatic ones.

```sh
git tag -a v0.4.0-rc1 -m "Release candidate 0.4.0-rc1" COMMIT
git push origin v0.4.0-rc1
```

## Stable releases

Publish a stable release only when the maintainer asks for it. Wait for CI to
pass on the intended `main` commit, then create and push the annotated tag of the
candidates' target version with the message `Release X.Y.Z`.

```sh
git tag -a v0.3.5 -m "Release 0.3.5" COMMIT
git push origin v0.3.5
```

The tag must be unused. Do not move or rename an existing tag. The tag push
builds and tests both platforms again and publishes the release. A last job then
marks the stable release with the highest version as GitHub's latest release, so
releases that finish publishing out of order still end with the newest one as
the latest, and runs the cleanup below. Rerunning that job after a failure
repeats only those steps. After `v0.3.5` exists, the next automatic candidate is
`v0.3.6-rc1`.

## Release cleanup

After a stable release is published with all its files, the last job keeps the
three newest stable releases by version and deletes older release entries and
their downloads. It also deletes published prereleases whose version is at or
below the new stable version. Candidates for higher versions, drafts and releases
with other tag names stay.

The cleanup never deletes Git tags, since the candidate numbering depends on them.
Candidate releases and failed builds start no cleanup. Publishing an older stable
release again skips the cleanup when a newer stable release exists. The next
stable release's cleanup removes candidates published after a cleanup.

Preview the cleanup after a release with a dry run. Add `--apply` to delete the
listed release entries and their downloads.

```sh
GH_TOKEN=$(gh auth token) node scripts/release.mjs prune --released-tag v0.3.5
```

## Package versions

The app, the GitHub release and the file names show the public version, including
the RC suffix. Each package format compares versions by its own rules, and a
stable release replaces every candidate of its version.

| Package | `0.3.5-rc1` | `0.3.5-rc2` | `0.3.5` |
|---|---|---|---|
| App, release and file names | `0.3.5-rc1` | `0.3.5-rc2` | `0.3.5` |
| Debian package version | `0.3.5~rc1` | `0.3.5~rc2` | `0.3.5` |
| MSI product version | `0.3.5.0` | `0.3.5.0` | `0.3.5.0` |

electron-builder writes the Debian version with `~`, which Debian sorts before
the version without it. MSI product versions have no suffix, so a version and all
its candidates share one product version. The MSI accepts an upgrade to the same
version, so installing a newer candidate or the release replaces the copy
installed before. Windows lists that shared version among the installed apps.
Settings > About in Downpad shows the public version.

Builds without a release tag, such as local and pull request builds, use the
version `0.0.0` from `package.json`.
