import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "./ci.mjs";

// Release tags are vMAJOR.MINOR.PATCH for stable releases and
// vMAJOR.MINOR.PATCH-rcN for release candidates. docs/releasing.md has the policy.

const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc([1-9]\d*))?$/;

/** Parse a release tag such as `v1.2.3` or `v1.2.3-rc4`. Any other name gives null,
 *  so unrelated tags never count as release versions. */
export function parseTag(tag) {
  const match = tagPattern.exec(typeof tag === "string" ? tag : "");
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const rc = match[4] === undefined ? null : Number(match[4]);
  if (![major, minor, patch].every(Number.isSafeInteger) || (rc !== null && !Number.isSafeInteger(rc))) return null;
  return { major, minor, patch, rc };
}

/** Order versions by their numeric part alone, ignoring any RC number. */
function compareBase(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function sameBase(left, right) {
  return compareBase(left, right) === 0;
}

function formatTag({ major, minor, patch, rc }) {
  return `v${major}.${minor}.${patch}${rc === null ? "" : `-rc${rc}`}`;
}

/** The tag of the next release candidate, given every existing tag name. The
 *  target is the patch after the newest stable tag, or a higher target that a
 *  candidate already uses, such as a hand-pushed v1.0.0-rc1. Every version tag
 *  counts as taken, also one without a release. */
export function nextCandidateTag(tagNames) {
  const versions = tagNames.map(parseTag).filter(Boolean);
  const latest = versions.filter((version) => version.rc === null)
    .reduce((newest, version) => (compareBase(version, newest) > 0 ? version : newest), { major: 0, minor: 0, patch: 0 });
  let target = { major: latest.major, minor: latest.minor, patch: latest.patch + 1 };
  for (const version of versions) {
    if (version.rc !== null && compareBase(version, target) > 0) target = version;
  }
  const rc = 1 + Math.max(0, ...versions.filter((version) => version.rc !== null && sameBase(version, target)).map((version) => version.rc));
  return formatTag({ ...target, rc });
}

function repositoryName(value) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? "")) throw new Error("A valid repository full name is required.");
  return value;
}

function commitSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("A full 40-character lowercase commit SHA is required.");
  return value;
}

/** Find the candidate tag that an earlier attempt of this CI run created on
 *  `sha`, so a rerun publishes the same candidate, also after a stable release
 *  of its version. The tag listing names each tag's commit, so only the
 *  annotations of candidate tags on `sha` are read. */
async function candidateOfRun(request, repository, refs, sha, message) {
  const onCommit = new Set();
  for (let page = 1; ; page += 1) {
    const batch = await request(`/repos/${repository}/tags?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid tag listing.");
    for (const tag of batch) {
      if (tag?.commit?.sha === sha && parseTag(tag.name)?.rc != null) onCommit.add(tag.name);
    }
    if (batch.length < 100) break;
  }
  for (const ref of refs) {
    const name = ref.ref.replace(/^refs\/tags\//, "");
    if (!onCommit.has(name) || ref.object?.type !== "tag") continue;
    const annotation = await request(`/repos/${repository}/git/tags/${commitSha(ref.object.sha)}`);
    if (annotation.object?.type === "commit" && annotation.object.sha === sha && annotation.message?.trimEnd() === message) return name;
  }
  return null;
}

/** Create the annotated tag of the next release candidate on `sha` and return
 *  its name. A retry of the same CI run returns the tag it created before.
 *  When a concurrent run takes the name first, it allocates the next one. */
export async function allocateCandidate({ request, repository, sha, runId }) {
  repositoryName(repository);
  commitSha(sha);
  if (!/^[1-9]\d*$/.test(String(runId ?? ""))) throw new Error("A CI run ID is required.");
  const message = `Release candidate for CI run ${runId}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refs = await request(`/repos/${repository}/git/matching-refs/tags/v`);
    if (!Array.isArray(refs) || !refs.every((ref) => typeof ref?.ref === "string")) throw new Error("GitHub returned an invalid tag listing.");
    const previous = await candidateOfRun(request, repository, refs, sha, message);
    if (previous) return previous;
    const tag = nextCandidateTag(refs.map((ref) => ref.ref.replace(/^refs\/tags\//, "")));
    const annotation = await request(`/repos/${repository}/git/tags`, { method: "POST", body: { tag, message, object: sha, type: "commit" } });
    commitSha(annotation?.sha);
    try {
      await request(`/repos/${repository}/git/refs`, { method: "POST", body: { ref: `refs/tags/${tag}`, sha: annotation.sha } });
      return tag;
    } catch (error) {
      // Allocate again only when the name exists now: another run took it, or
      // this request succeeded but its response was lost. Then the next
      // listing finds this run's tag or picks the next free name.
      try { await request(`/repos/${repository}/git/ref/tags/${tag}`); } catch { throw error; }
    }
  }
  throw new Error("Could not allocate a release candidate tag after five concurrent collisions.");
}

/** The files that every published release must carry before cleanup may
 *  delete older releases. */
export function releaseAssets(tag) {
  const version = tag.slice(1);
  return [
    `Downpad-${version}-linux-x86_64.AppImage`,
    `Downpad-${version}-linux-amd64.deb`,
    `Downpad-${version}-win-x64.msi`,
    "SHA256SUMS",
  ];
}

/** Reject malformed API data before it can influence a deletion plan. */
function parseRelease(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid release response.");
  const { id, tag_name: tag, draft, prerelease, published_at: publishedAt, assets } = raw;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof tag !== "string" || typeof draft !== "boolean" ||
    typeof prerelease !== "boolean" || (publishedAt !== null && typeof publishedAt !== "string") || !Array.isArray(assets)) {
    throw new Error("Invalid release metadata.");
  }
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || typeof asset.state !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error("Invalid release asset metadata.");
    }
  }
  return {
    id, tag, draft, prerelease, publishedAt,
    assets: assets.map(({ name, state, size }) => ({ name, state, size })),
    version: parseTag(tag),
  };
}

function isStable(release) {
  return release.version !== null && release.version.rc === null && !release.draft && !release.prerelease && Boolean(release.publishedAt);
}

/** Decide which of the API's `listed` releases to delete after `releasedTag`
 *  was published. Keeps the three newest stable releases and deletes older
 *  ones, plus published prereleases up to the released version. Drafts and
 *  releases with other tag names stay. Returns `skip` instead when a newer
 *  stable release exists. */
export function cleanupPlan(listed, releasedTag) {
  const released = parseTag(releasedTag);
  if (!released || released.rc !== null) throw new Error("Cleanup requires a stable version tag.");
  const releases = listed.map(parseRelease);
  const stable = releases.filter(isStable).sort((left, right) => compareBase(right.version, left.version));
  const trigger = stable.find((release) => release.tag === releasedTag);
  if (!trigger) throw new Error(`${releasedTag} is not a published stable release.`);
  if (compareBase(stable[0].version, released) > 0) {
    return { keep: stable.slice(0, 3), delete: [], skip: `${releasedTag} is no longer the newest stable release.` };
  }
  const uploaded = new Set(trigger.assets.filter((asset) => asset.state === "uploaded" && asset.size > 0).map((asset) => asset.name));
  const missing = releaseAssets(releasedTag).filter((name) => !uploaded.has(name));
  if (missing.length > 0) throw new Error(`${releasedTag} publication is incomplete. Missing uploaded assets: ${missing.join(", ")}.`);
  const superseded = releases
    .filter((release) => release.prerelease && !release.draft && release.publishedAt && release.version !== null && compareBase(release.version, released) <= 0)
    .sort((left, right) => left.tag.localeCompare(right.tag));
  return { keep: stable.slice(0, 3), delete: [...stable.slice(3), ...superseded] };
}

/** Read every release of the repository as the API lists them, 100 per page. */
async function listReleases(request, repository) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid release listing.");
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  if (new Set(releases.map((release) => release?.id)).size !== releases.length) {
    throw new Error("The release listing changed while it was read. Run the cleanup again.");
  }
  return releases;
}

/** Mark the stable release with the highest version as GitHub's latest release,
 *  which installed copies read for updates. Stable releases are published
 *  without that mark, and only this step sets it. After each change it reads the
 *  releases again, so a run that read the list before a newer release appeared
 *  never leaves an older one as the latest: it marks the newer one next. */
export async function markLatest({ request, repository, log = console.log }) {
  repositoryName(repository);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stable = (await listReleases(request, repository)).map(parseRelease).filter(isStable)
      .sort((left, right) => compareBase(right.version, left.version));
    if (stable.length === 0) {
      log("No stable release to mark as the latest.");
      return;
    }
    const newest = stable[0];
    const current = await request(`/repos/${repository}/releases/latest`).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (current?.id === newest.id) {
      log(`${newest.tag} is the latest release.`);
      return;
    }
    await request(`/repos/${repository}/releases/${newest.id}`, { method: "PATCH", body: { make_latest: "true" } });
    log(`Marked ${newest.tag} as the latest release.`);
  }
  throw new Error("The latest release kept changing. Run this step again.");
}

/** Delete the release entries and downloads that `cleanupPlan` selects after
 *  `releasedTag`. Without `apply` it only prints the plan. Git tags stay, since
 *  the candidate numbering depends on them. Each deletion first checks the plan
 *  again, so a release published or changed meanwhile is never deleted by an
 *  outdated listing. */
export async function pruneReleases({ request, repository, releasedTag, apply = false, log = console.log }) {
  repositoryName(repository);
  const plan = cleanupPlan(await listReleases(request, repository), releasedTag);
  if (plan.skip) {
    log(`Skipping cleanup. ${plan.skip}`);
    return;
  }
  log(`Keep stable releases ${plan.keep.map((release) => release.tag).join(", ")}`);
  for (const release of plan.delete) log(`${apply ? "Delete" : "Would delete"} release ${release.tag} (ID ${release.id})`);
  if (!apply) {
    log("Dry run. Pass --apply to delete these release entries and their downloads. Git tags stay.");
    return;
  }
  for (const candidate of plan.delete) {
    const fresh = cleanupPlan(await listReleases(request, repository), releasedTag);
    if (fresh.skip) {
      log(`Stopping cleanup. ${fresh.skip}`);
      return;
    }
    if (!fresh.delete.some((release) => release.id === candidate.id && release.tag === candidate.tag && release.prerelease === candidate.prerelease)) {
      log(`Skipping changed or removed release ${candidate.tag}`);
      continue;
    }
    const route = `/repos/${repository}/releases/${candidate.id}`;
    try {
      const current = parseRelease(await request(route));
      if (current.tag !== candidate.tag || current.draft !== candidate.draft || current.prerelease !== candidate.prerelease) {
        log(`Skipping changed release ${candidate.tag}`);
        continue;
      }
      await request(route, { method: "DELETE" });
    } catch (error) {
      // GitHub also answers 404 for a repository it hides, so only a complete
      // listing without the release proves that another cleanup removed it.
      if (error.status !== 404 || (await listReleases(request, repository)).some((release) => release?.id === candidate.id)) throw error;
      log(`Release ${candidate.tag} was already removed`);
      continue;
    }
    log(`Deleted release ${candidate.tag}. Its Git tag stays.`);
  }
}

/** Run `candidate` in CI after a main push, `latest` after a stable release, or
 *  `prune --released-tag vX.Y.Z [--apply]`. */
async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...options] = argv;
  const request = createGitHubClient(env);
  if (command === "candidate") {
    const tag = await allocateCandidate({ request, repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID });
    const output = `tag=${tag}\nversion=${tag.slice(1)}\n`;
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
    return;
  }
  if (command === "latest") {
    await markLatest({ request, repository: env.GITHUB_REPOSITORY ?? "lincarl/downpad" });
    return;
  }
  if (command === "prune") {
    const tagIndex = options.indexOf("--released-tag");
    const releasedTag = tagIndex >= 0 ? options[tagIndex + 1] : undefined;
    const unknown = options.filter((option, index) => option !== "--apply" && index !== tagIndex && index !== tagIndex + 1);
    if (!releasedTag || unknown.length > 0) throw new Error("Usage: release.mjs prune --released-tag vX.Y.Z [--apply]");
    await pruneReleases({ request, repository: env.GITHUB_REPOSITORY ?? "lincarl/downpad", releasedTag, apply: options.includes("--apply") });
    return;
  }
  throw new Error("Expected candidate, latest or prune.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
