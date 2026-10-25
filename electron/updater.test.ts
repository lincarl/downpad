import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateInfo } from "../src/ipc/contracts";
import { CHECK_INTERVAL_MS, type PackageKind } from "./updatePlan";
import { Updater } from "./updater";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const NOW = Date.UTC(2026, 9, 25, 12);
const PACKAGE = Buffer.from("the new Downpad AppImage");
const DIGEST = createHash("sha256").update(PACKAGE).digest("hex");

interface ServerOptions {
  version?: string;
  answer?: string;
  status?: number;
  digest?: string;
  body?: Buffer;
  fail?: boolean;
}

/** A fake GitHub serving the latest release and its AppImage, counting requests. */
function server(options: ServerOptions = {}) {
  const version = options.version ?? "1.3.0";
  const calls: string[] = [];
  const name = `Downpad-${version}-linux-x86_64.AppImage`;
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (options.fail) throw new TypeError("fetch failed");
    if (url === "https://api.github.com/repos/lincarl/downpad/releases/latest") {
      return new Response(options.answer ?? JSON.stringify({
        tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/lincarl/downpad/releases/tag/v${version}`,
        assets: [{ name, browser_download_url: `https://example.com/${name}`, digest: `sha256:${options.digest ?? DIGEST}` }],
      }), { status: options.status ?? 200 });
    }
    if (url === `https://example.com/${name}`) {
      const body = options.body ?? PACKAGE;
      return new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } });
    }
    return new Response("Not Found", { status: 404 });
  };
  return { fetch, calls, name };
}

async function folder(): Promise<string> {
  const root = resolve("dev-temp", "updater-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "run-"));
  directories.push(directory);
  return directory;
}

/** An updater for an AppImage copy of version 1.2.0, recording what Settings would show. */
async function updater(fetch: (url: string) => Promise<Response>, { version = "1.2.0", kind = "appimage" as PackageKind | null, now = NOW, directory = "" } = {}) {
  const updates = directory || (await folder());
  const shown: UpdateInfo[] = [];
  const instance = new Updater({ version, kind, directory: updates, fetch, now: () => now, onChange: (info) => shown.push(info) });
  return { instance, updates, shown };
}

async function state(updates: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(updates, "appimage", "state.json"), "utf8")) as Record<string, unknown>;
}

describe("Updater checks", () => {
  it("downloads a newer release, verifies it and keeps it for the next start", async () => {
    const github = server();
    const { instance, updates, shown } = await updater(github.fetch);
    await instance.checkNow();
    expect(instance.info()).toEqual({ version: "1.2.0", selfUpdate: true, lastCheckMs: NOW, state: { status: "ready", version: "1.3.0" } });
    expect(shown.map((info) => info.state.status)).toEqual(["checking", "downloading", "downloading", "ready"]);
    expect(await readFile(join(updates, "appimage", github.name))).toEqual(PACKAGE);
    expect(await state(updates)).toEqual({ lastCheckMs: NOW, pending: { version: "1.3.0", file: github.name, sha256: DIGEST, approved: true } });
    expect((await readdir(join(updates, "appimage"))).sort()).toEqual([github.name, "state.json"]);

    const next = await updater(github.fetch, { directory: updates });
    expect(await next.instance.start(false)).toEqual({ version: "1.3.0", file: join(updates, "appimage", github.name), sha256: DIGEST });
  });

  it("discards a download whose digest differs from the release's", async () => {
    const github = server({ body: Buffer.from("tampered") });
    const { instance, updates } = await updater(github.fetch);
    await instance.checkNow();
    expect(instance.info().state).toEqual({ status: "failed", message: "Couldn't download Downpad 1.3.0. The downloaded update failed its integrity check and was discarded." });
    expect(await readdir(join(updates, "appimage"))).toEqual([]);
  });

  it("reports up to date for the same, an older or a candidate release, and resets the interval", async () => {
    for (const fields of [{ version: "1.2.0" }, { version: "1.1.9" }, { answer: JSON.stringify({ tag_name: "v9.0.0-rc1", prerelease: true }) }]) {
      const github = server(fields);
      const { instance, updates } = await updater(github.fetch);
      await instance.checkNow();
      expect(instance.info().state).toEqual({ status: "up-to-date" });
      expect(await state(updates)).toEqual({ lastCheckMs: NOW });
      expect(github.calls).toHaveLength(1);
    }
  });

  it("updates a release candidate to the release of its own version", async () => {
    const github = server({ version: "1.2.0" });
    const { instance } = await updater(github.fetch, { version: "1.2.0-rc3" });
    await instance.checkNow();
    expect(instance.info().state).toEqual({ status: "ready", version: "1.2.0" });
  });

  it("keeps the check due after a failed request or an answer that is not a release", async () => {
    for (const options of [{ fail: true }, { status: 503 }, { answer: "<html>Blocked by policy</html>" }]) {
      const { instance, updates } = await updater(server(options).fetch);
      await instance.checkNow();
      expect(instance.info().state.status).toBe("failed");
      expect(instance.info().lastCheckMs).toBeNull();
      await expect(readdir(join(updates, "appimage"))).rejects.toThrow();
    }
    const { instance } = await updater(server({ answer: "[]" }).fetch);
    await instance.checkNow();
    expect(instance.info().state).toEqual({ status: "failed", message: "Couldn't check for updates. The update server's answer couldn't be read." });
  });

  it("offers the release page to a copy that cannot install updates itself", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch, { kind: null });
    await instance.checkNow();
    expect(instance.info()).toEqual({
      version: "1.2.0", selfUpdate: false, lastCheckMs: NOW,
      state: { status: "available", version: "1.3.0", pageUrl: "https://github.com/lincarl/downpad/releases/tag/v1.3.0" },
    });
    expect(github.calls).toHaveLength(1);
    expect(await readdir(updates)).toEqual([]);
  });

  it("offers the release page when the release lacks a verifiable package", async () => {
    const github = server({ digest: "" });
    const { instance } = await updater(github.fetch);
    await instance.checkNow();
    expect(instance.info().state).toEqual({ status: "available", version: "1.3.0", pageUrl: "https://github.com/lincarl/downpad/releases/tag/v1.3.0" });
  });

  it("joins a check that is already running instead of starting another", async () => {
    const github = server();
    const { instance } = await updater(github.fetch);
    await Promise.all([instance.checkNow(), instance.checkNow()]);
    expect(github.calls).toEqual(["https://api.github.com/repos/lincarl/downpad/releases/latest", `https://example.com/${github.name}`]);
  });

  it("does not download again a package that already waits", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkNow();
    const again = await updater(github.fetch, { directory: updates });
    await again.instance.start(true);
    await again.instance.checkNow();
    expect(again.instance.info().state).toEqual({ status: "ready", version: "1.3.0" });
    expect(github.calls.filter((url) => url.startsWith("https://example.com/"))).toHaveLength(1);
  });
});

describe("Automatic updates", () => {
  it("checks only when automatic updates are on and 30 days have passed", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkIfDue(false);
    expect(github.calls).toHaveLength(0);
    await instance.checkIfDue(true);
    expect(github.calls).toHaveLength(2);
    expect(await state(updates)).toMatchObject({ lastCheckMs: NOW, pending: { approved: false } });

    const quiet = server({ version: "1.3.0" });
    const early = await updater(quiet.fetch, { directory: updates, version: "1.3.0", now: NOW + CHECK_INTERVAL_MS - 1 });
    await early.instance.start(true);
    await early.instance.checkIfDue(true);
    expect(quiet.calls).toHaveLength(0);
    const due = await updater(quiet.fetch, { directory: updates, version: "1.3.0", now: NOW + CHECK_INTERVAL_MS });
    await due.instance.start(true);
    await due.instance.checkIfDue(true);
    expect(quiet.calls).toHaveLength(1);
  });

  it("checks silently and leaves a failed automatic check due", async () => {
    const { instance, shown } = await updater(server({ fail: true }).fetch);
    await instance.checkIfDue(true);
    expect(shown).toEqual([]);
    expect(instance.info()).toMatchObject({ lastCheckMs: null, state: { status: "idle" } });
  });

  it("installs an automatic download at start only while automatic updates are on", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkIfDue(true);
    expect(await (await updater(github.fetch, { directory: updates })).instance.start(true)).not.toBeNull();
    expect(await (await updater(github.fetch, { directory: updates })).instance.start(false)).toBeNull();
    expect(await readdir(join(updates, "appimage"))).toEqual(["state.json"]);
  });

  it("deletes an automatic download when automatic updates are switched off, but keeps one the user asked for", async () => {
    const automatic = await updater(server().fetch);
    await automatic.instance.checkIfDue(true);
    await automatic.instance.automaticUpdatesOff();
    expect(automatic.instance.info().state).toEqual({ status: "idle" });
    expect(await readdir(join(automatic.updates, "appimage"))).toEqual(["state.json"]);

    const manual = await updater(server().fetch);
    await manual.instance.checkNow();
    await manual.instance.automaticUpdatesOff();
    expect(await (await updater(server().fetch, { directory: manual.updates })).instance.start(false)).not.toBeNull();
  });

  it("installs an automatic download chosen with Restart now also with automatic updates off", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkIfDue(true);
    expect(await instance.approve()).toBe(true);
    expect(await (await updater(github.fetch, { directory: updates })).instance.start(false)).not.toBeNull();
  });
});

describe("Update state at start", () => {
  it("deletes the package of the version now running, leftovers and unfinished downloads", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkNow();
    await writeFile(join(updates, "appimage", "Downpad-1.3.0-linux-x86_64.AppImage.part"), "partial");
    await writeFile(join(updates, "appimage", "Downpad-1.1.0-linux-x86_64.AppImage"), "old");
    const updated = await updater(github.fetch, { directory: updates, version: "1.3.0" });
    expect(await updated.instance.start(true)).toBeNull();
    expect(await readdir(join(updates, "appimage"))).toEqual(["state.json"]);
    expect(await state(updates)).toEqual({ lastCheckMs: NOW });
    expect(updated.instance.info().lastCheckMs).toBe(NOW);
  });

  it("refuses a saved update whose file is missing or named for another kind or version", async () => {
    const { updates } = await updater(server().fetch);
    await mkdir(join(updates, "appimage"), { recursive: true });
    for (const pending of [
      { version: "1.3.0", file: "Downpad-1.3.0-linux-x86_64.AppImage", sha256: DIGEST },
      { version: "1.3.0", file: "Downpad-1.3.0-linux-amd64.deb", sha256: DIGEST },
      { version: "1.3.0", file: "../../escape.AppImage", sha256: DIGEST },
      { version: "1.3.0", file: "Downpad-1.4.0-linux-x86_64.AppImage", sha256: DIGEST },
      { version: "1.3.0", file: "Downpad-1.3.0-linux-x86_64.AppImage", sha256: "abc" },
    ]) {
      await writeFile(join(updates, "appimage", "state.json"), JSON.stringify({ pending: { ...pending, approved: true } }));
      if (pending.file === "Downpad-1.3.0-linux-amd64.deb") await writeFile(join(updates, "appimage", pending.file), PACKAGE);
      expect(await (await updater(server().fetch, { directory: updates })).instance.start(true)).toBeNull();
    }
  });

  it("forgets a download that the start could not install and waits for the next due check", async () => {
    const github = server();
    const { instance, updates } = await updater(github.fetch);
    await instance.checkNow();
    const start = await updater(github.fetch, { directory: updates, now: NOW + 1000 });
    await start.instance.start(true);
    await start.instance.dropPending("Couldn't install Downpad 1.3.0. The disk is full.");
    expect(start.instance.info()).toMatchObject({ lastCheckMs: NOW + 1000, state: { status: "failed", message: "Couldn't install Downpad 1.3.0. The disk is full." } });
    expect(await readdir(join(updates, "appimage"))).toEqual(["state.json"]);
    expect(await (await updater(github.fetch, { directory: updates })).instance.start(true)).toBeNull();
  });

  it("does nothing for a copy that cannot install updates itself", async () => {
    const { instance, updates } = await updater(server().fetch, { kind: null });
    expect(await instance.start(true)).toBeNull();
    await instance.checkIfDue(true);
    expect(await instance.approve()).toBe(false);
    expect(await readdir(updates)).toEqual([]);
  });

  it("accepts only HTTPS for the release address, or HTTP on this computer for tests", () => {
    const fetch = server().fetch;
    expect(() => new Updater({ version: "1.2.0", kind: null, directory: "unused", fetch, apiUrl: "http://example.com/latest" })).toThrow(/HTTPS/);
    expect(() => new Updater({ version: "1.2.0", kind: null, directory: "unused", fetch, apiUrl: "http://127.0.0.1:9/latest" })).not.toThrow();
  });
});
