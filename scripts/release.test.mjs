import assert from "node:assert/strict";
import test from "node:test";
import { allocateCandidate, cleanupPlan, markLatest, nextCandidateTag, parseTag, pruneReleases, releaseAssets } from "./release.mjs";

const repository = "example/app";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

test("parses stable and candidate tags and rejects other names", () => {
  assert.deepEqual(parseTag("v1.2.3"), { major: 1, minor: 2, patch: 3, rc: null });
  assert.deepEqual(parseTag("v0.3.5-rc12"), { major: 0, minor: 3, patch: 5, rc: 12 });
  for (const tag of ["1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc0", "v1.2.3-rc01", "v1.2.3-beta.1", "v1.2.3-rc1-hotfix", "release-1", undefined]) {
    assert.equal(parseTag(tag), null, String(tag));
  }
});

test("numbers candidates after the newest stable tag and continues a higher hand-pushed target", () => {
  const history = ["v0.2.2", "v0.3.0", "v0.3.1", "v0.3.2", "v0.3.3", "v0.3.4", "nightly", "v1.0"];
  assert.equal(nextCandidateTag([]), "v0.0.1-rc1");
  assert.equal(nextCandidateTag(history), "v0.3.5-rc1");
  assert.equal(nextCandidateTag([...history, "v0.3.5-rc1", "v0.3.5-rc2"]), "v0.3.5-rc3");
  // A stable release ends its candidates. Older candidate tags stay taken but no longer count.
  assert.equal(nextCandidateTag([...history, "v0.3.5-rc1", "v0.3.5-rc2", "v0.3.5"]), "v0.3.6-rc1");
  assert.equal(nextCandidateTag([...history, "v0.4.0-rc1"]), "v0.4.0-rc2");
  // A stable tag pushed without candidates still moves the next target past it.
  assert.equal(nextCandidateTag([...history, "v0.3.5-rc1", "v0.4.0"]), "v0.4.1-rc1");
});

/** A fake GitHub API holding tags. `beforeCreate` can add a competing tag
 *  just before this run's ref is created. */
function tagServer({ tags = {}, beforeCreate, loseResponse = false, failCreate } = {}) {
  const server = { tags: { ...tags }, annotations: {}, calls: [] };
  let nextObject = 1;
  server.request = async (route, { method = "GET", body } = {}) => {
    server.calls.push(`${method} ${route}`);
    if (method === "GET" && route === `/repos/${repository}/git/matching-refs/tags/v`) {
      return Object.entries(server.tags).map(([name, object]) => ({ ref: `refs/tags/${name}`, object }));
    }
    const page = /^\/repos\/example\/app\/tags\?per_page=100&page=(\d+)$/.exec(route);
    if (method === "GET" && page) {
      // The tag listing names the commit of each tag, also of an annotated one.
      const listed = Object.entries(server.tags).map(([name, object]) => ({
        name, commit: { sha: object.type === "tag" ? server.annotations[object.sha]?.object.sha ?? otherSha : object.sha },
      }));
      return listed.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100);
    }
    const annotation = /^\/repos\/example\/app\/git\/tags\/([a-f0-9]{40})$/.exec(route);
    if (method === "GET" && annotation) return server.annotations[annotation[1]];
    if (method === "POST" && route === `/repos/${repository}/git/tags`) {
      const objectSha = String(nextObject++).padStart(40, "c");
      server.annotations[objectSha] = { object: { type: body.type, sha: body.object }, message: `${body.message}\n` };
      return { sha: objectSha };
    }
    if (method === "POST" && route === `/repos/${repository}/git/refs`) {
      beforeCreate?.(server);
      const name = body.ref.replace("refs/tags/", "");
      if (failCreate) throw Object.assign(new Error("server error"), { status: 500 });
      if (server.tags[name]) throw Object.assign(new Error("Reference already exists"), { status: 422 });
      server.tags[name] = { type: "tag", sha: body.sha };
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("connection reset"), { status: 502 });
      }
      return { ref: body.ref };
    }
    const ref = /^\/repos\/example\/app\/git\/ref\/tags\/(.+)$/.exec(route);
    if (method === "GET" && ref) {
      if (server.tags[ref[1]]) return { ref: `refs/tags/${ref[1]}`, object: server.tags[ref[1]] };
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    throw new Error(`Unexpected ${method} ${route}`);
  };
  return server;
}

const stableTags = { "v0.3.3": { type: "commit", sha: otherSha }, "v0.3.4": { type: "tag", sha: "d".repeat(40) } };

test("tags the commit as the next candidate and names the CI run in the annotation", async () => {
  const server = tagServer({ tags: stableTags });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  const created = server.tags["v0.3.5-rc1"];
  assert.equal(created.type, "tag");
  assert.deepEqual(server.annotations[created.sha], { object: { type: "commit", sha }, message: "Release candidate for CI run 42\n" });
});

test("a retried run returns its own candidate instead of taking another number", async () => {
  const server = tagServer({ tags: stableTags });
  const first = await allocateCandidate({ request: server.request, repository, sha, runId: "42" });
  // Another run's candidate on another commit does not match.
  await allocateCandidate({ request: server.request, repository, sha: otherSha, runId: "43" });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), first);
  assert.deepEqual(Object.keys(server.tags).sort(), ["v0.3.3", "v0.3.4", "v0.3.5-rc1", "v0.3.5-rc2"]);
});

test("a rerun after the stable release of its version returns its own candidate", async () => {
  const server = tagServer({ tags: stableTags });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  server.tags["v0.3.5"] = { type: "commit", sha };
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "43" }), "v0.3.6-rc1");
});

test("finds the run's candidate among more than a page of tags", async () => {
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`v0.1.${index}`, { type: "commit", sha: otherSha }]));
  const server = tagServer({ tags: { ...many, ...stableTags } });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  assert.ok(server.calls.includes(`GET /repos/${repository}/tags?per_page=100&page=2`));
});

test("a concurrent run that takes the name first moves this run to the next number", async () => {
  const server = tagServer({
    tags: stableTags,
    beforeCreate: (current) => { current.tags["v0.3.5-rc1"] ??= { type: "commit", sha: otherSha }; },
  });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc2");
});

test("a lost response finds the tag this run created", async () => {
  const server = tagServer({ tags: stableTags, loseResponse: true });
  assert.equal(await allocateCandidate({ request: server.request, repository, sha, runId: "42" }), "v0.3.5-rc1");
  assert.equal(Object.keys(server.tags).length, 3);
});

test("a failed tag creation that left no tag is reported", async () => {
  const server = tagServer({ tags: stableTags, failCreate: true });
  await assert.rejects(allocateCandidate({ request: server.request, repository, sha, runId: "42" }), /server error/);
});

test("rejects invalid run details before calling GitHub", async () => {
  const server = tagServer();
  await assert.rejects(allocateCandidate({ request: server.request, repository, sha: "abc", runId: "42" }), /40-character/);
  await assert.rejects(allocateCandidate({ request: server.request, repository, sha, runId: "0" }), /run ID/);
  await assert.rejects(allocateCandidate({ request: server.request, repository: "bad name", sha, runId: "42" }), /repository/);
  assert.deepEqual(server.calls, []);
});

let releaseId = 100;
/** A published release as the GitHub API lists it. */
function release(tag, { prerelease = /-rc/.test(tag), draft = false, assets = releaseAssets(tag), publishedAt = "2026-10-25T10:00:00Z" } = {}) {
  return {
    id: releaseId++, tag_name: tag, draft, prerelease, published_at: draft ? null : publishedAt,
    assets: assets.map((name) => ({ name, state: "uploaded", size: 10 })),
  };
}

/** Plan the cleanup after `tag` and name the releases involved. */
function plan(releases, tag) {
  const result = cleanupPlan(releases, tag);
  return { keep: result.keep.map((item) => item.tag), delete: result.delete.map((item) => item.tag), skip: result.skip };
}

test("after a stable release, keeps the three newest stable releases and removes superseded candidates", () => {
  const releases = [
    release("v0.3.1", { assets: ["md-easy-0.3.1-win-x64.msi"] }),
    release("v0.3.3", { assets: ["md-easy-0.3.3-win-x64.msi"] }),
    release("v0.3.4", { assets: ["md-easy-0.3.4-win-x64.msi"] }),
    release("v0.3.5-rc1"),
    release("v0.3.5-rc2"),
    release("v0.3.5"),
    release("v0.3.6-rc1"),
    release("v0.3.6-rc2", { draft: true }),
    release("nightly", { prerelease: true }),
  ];
  assert.deepEqual(plan(releases, "v0.3.5"), {
    keep: ["v0.3.5", "v0.3.4", "v0.3.3"],
    delete: ["v0.3.1", "v0.3.5-rc1", "v0.3.5-rc2"],
    skip: undefined,
  });
});

test("sorts stable releases by version, not by publication order", () => {
  const releases = [release("v0.10.0"), release("v0.9.0"), release("v0.2.0"), release("v0.11.0")];
  assert.deepEqual(plan(releases, "v0.11.0").delete, ["v0.2.0"]);
});

test("skips cleanup for an older stable release published again", () => {
  const releases = [release("v0.3.4"), release("v0.3.5"), release("v0.3.5-rc1")];
  assert.deepEqual(plan(releases, "v0.3.4"), { keep: ["v0.3.5", "v0.3.4"], delete: [], skip: "v0.3.4 is no longer the newest stable release." });
});

test("refuses cleanup when the stable release is missing, a candidate or incomplete", () => {
  assert.throws(() => plan([release("v0.3.5-rc1")], "v0.3.5-rc1"), /stable version tag/);
  assert.throws(() => plan([release("v0.3.4")], "v0.3.5"), /not a published stable release/);
  assert.throws(() => plan([release("v0.3.5", { draft: true })], "v0.3.5"), /not a published stable release/);
  const incomplete = release("v0.3.5", { assets: ["Downpad-0.3.5-linux-amd64.deb", "SHA256SUMS"] });
  assert.throws(() => plan([incomplete], "v0.3.5"), /incomplete. Missing uploaded assets: Downpad-0.3.5-linux-x86_64.AppImage, Downpad-0.3.5-win-x64.msi/);
  const empty = release("v0.3.5");
  empty.assets[0].size = 0;
  assert.throws(() => plan([empty], "v0.3.5"), /incomplete/);
});

test("rejects malformed release data before planning deletions", () => {
  const broken = release("v0.3.5");
  broken.assets[0].size = -1;
  assert.throws(() => plan([broken], "v0.3.5"), /Invalid release asset metadata/);
  assert.throws(() => plan([{ ...release("v0.3.5"), id: "7" }], "v0.3.5"), /Invalid release metadata/);
});

/** A fake release API with paging, deletion and GitHub's latest release. */
function releaseServer(releases, { onDelete, onPatch, latest } = {}) {
  const server = { releases: [...releases], deleted: [], calls: [], latest };
  server.request = async (route, { method = "GET", body } = {}) => {
    server.calls.push(`${method} ${route}`);
    if (route === `/repos/${repository}/releases/latest`) {
      const current = server.releases.find((item) => item.id === server.latest);
      if (!current) throw Object.assign(new Error("Not Found"), { status: 404 });
      return current;
    }
    const page = /^\/repos\/example\/app\/releases\?per_page=100&page=(\d+)$/.exec(route);
    if (method === "GET" && page) return server.releases.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100);
    const one = /^\/repos\/example\/app\/releases\/(\d+)$/.exec(route);
    const index = one ? server.releases.findIndex((item) => item.id === Number(one[1])) : -1;
    if (one && index < 0) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (method === "GET" && one) return server.releases[index];
    if (method === "PATCH" && one && body?.make_latest === "true") {
      onPatch?.(server);
      server.latest = server.releases[index].id;
      return server.releases[index];
    }
    if (method === "DELETE" && one) {
      server.deleted.push(server.releases[index].tag_name);
      server.releases.splice(index, 1);
      onDelete?.(server);
      return undefined;
    }
    throw new Error(`Unexpected ${method} ${route}`);
  };
  return server;
}

test("a dry run lists the plan and deletes nothing", async () => {
  const server = releaseServer([release("v0.3.4"), release("v0.3.5-rc1"), release("v0.3.5")]);
  const lines = [];
  await pruneReleases({ request: server.request, repository, releasedTag: "v0.3.5", log: (line) => lines.push(line) });
  assert.deepEqual(server.deleted, []);
  assert.match(lines.join("\n"), /Would delete release v0\.3\.5-rc1/);
  assert.match(lines.join("\n"), /Dry run/);
});

test("applies the plan across pages and keeps a release that another cleanup removed meanwhile", async () => {
  const filler = Array.from({ length: 120 }, (_, index) => release(`v0.1.${index}`));
  const server = releaseServer([...filler, release("v0.3.5-rc1"), release("v0.3.5-rc2"), release("v0.3.5")], {
    onDelete: (current) => {
      // Another cleanup removes rc2 while this one runs.
      const other = current.releases.findIndex((item) => item.tag_name === "v0.3.5-rc2");
      if (other >= 0) current.releases.splice(other, 1);
    },
  });
  const lines = [];
  await pruneReleases({ request: server.request, repository, releasedTag: "v0.3.5", apply: true, log: (line) => lines.push(line) });
  assert.ok(server.deleted.includes("v0.3.5-rc1"));
  assert.ok(!server.deleted.includes("v0.3.5-rc2"));
  assert.deepEqual(server.releases.map((item) => item.tag_name).sort(), ["v0.1.118", "v0.1.119", "v0.3.5"]);
  assert.match(lines.join("\n"), /Skipping changed or removed release v0\.3\.5-rc2/);
});

test("stops when a newer stable release appears during cleanup", async () => {
  const server = releaseServer([release("v0.3.1"), release("v0.3.2"), release("v0.3.3"), release("v0.3.4"), release("v0.3.5-rc1"), release("v0.3.5")], {
    onDelete: (current) => { current.releases.push(release("v0.3.6")); },
  });
  const lines = [];
  await pruneReleases({ request: server.request, repository, releasedTag: "v0.3.5", apply: true, log: (line) => lines.push(line) });
  assert.equal(server.deleted.length, 1);
  assert.match(lines.join("\n"), /Stopping cleanup. v0\.3\.5 is no longer the newest stable release/);
});

test("marks the stable release with the highest version as the latest", async () => {
  const older = release("v0.3.5");
  const newer = release("v0.3.6");
  // v0.3.5 finished publishing last and took the latest mark.
  const server = releaseServer([newer, release("v0.3.7-rc1"), release("v0.4.0", { draft: true }), older], { latest: older.id });
  const lines = [];
  await markLatest({ request: server.request, repository, log: (line) => lines.push(line) });
  assert.equal(server.latest, newer.id);
  assert.deepEqual(lines, ["Marked v0.3.6 as the latest release.", "v0.3.6 is the latest release."]);
});

test("marks the newest release explicitly also when GitHub already shows it as the latest", async () => {
  // GitHub picks a latest release on its own until one is marked.
  const only = release("v0.3.5");
  const server = releaseServer([release("v0.3.4"), only], { latest: only.id });
  await markLatest({ request: server.request, repository, log: () => {} });
  assert.deepEqual(server.calls.filter((call) => call.startsWith("PATCH")), [`PATCH /repos/${repository}/releases/${only.id}`]);
});

test("marks a release as the latest when none is, and does nothing without a stable release", async () => {
  const only = release("v0.3.5");
  const server = releaseServer([only]);
  await markLatest({ request: server.request, repository, log: () => {} });
  assert.equal(server.latest, only.id);
  const empty = releaseServer([release("v0.3.6-rc1")]);
  await markLatest({ request: empty.request, repository, log: () => {} });
  assert.equal(empty.calls.some((call) => call.startsWith("PATCH")), false);
});

test("marks the newer release when another run published and marked it while this one worked", async () => {
  const older = release("v0.3.5");
  const newer = release("v0.3.6");
  let raced = false;
  const server = releaseServer([older, release("v0.3.4")], {
    onPatch: (current) => {
      // The v0.3.6 run publishes and marks its release after this run read the list.
      if (raced) return;
      raced = true;
      current.releases.push(newer);
      current.latest = newer.id;
    },
  });
  const lines = [];
  await markLatest({ request: server.request, repository, log: (line) => lines.push(line) });
  assert.equal(server.latest, newer.id);
  assert.deepEqual(lines, ["Marked v0.3.5 as the latest release.", "Marked v0.3.6 as the latest release.", "v0.3.6 is the latest release."]);
});

test("gives up after five changes, but not when the fifth one holds", async () => {
  /** A server where each of the first `races` marks meets a newer release. */
  const racing = (races) => {
    let version = 6;
    return releaseServer([release("v0.3.5")], {
      onPatch: (current) => { if (version < 6 + races) current.releases.push(release(`v0.3.${version++}`)); },
    });
  };
  await assert.rejects(markLatest({ request: racing(5).request, repository, log: () => {} }), /kept changing/);
  const settled = racing(4);
  await markLatest({ request: settled.request, repository, log: () => {} });
  assert.equal(settled.releases.find((item) => item.id === settled.latest)?.tag_name, "v0.3.9");
  assert.equal(settled.calls.filter((call) => call.startsWith("PATCH")).length, 5);
});
