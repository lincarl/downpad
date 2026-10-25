import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { powershellInvocation, supervise } from "./run-msi-test.mjs";

const launcher = new URL("./run-msi-test.mjs", import.meta.url);
const scratch = fileURLToPath(new URL("../dev-temp/", import.meta.url));
const execute = promisify(execFile);

/** Keep each real subprocess test and its diagnostics inside the worktree. */
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(path.join(scratch, "msi-supervisor-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

/** Verify that the supervisor process itself exits without a forced process.exit. */
async function runWorker(t, source, { setup = "", command, timeoutMs = 6000, terminationMs = 1000 } = {}) {
  const cwd = await fixture(t);
  const script = `
    ${setup}
    const { supervise } = await import(${JSON.stringify(launcher.href)});
    const result = await supervise(${JSON.stringify(command ?? process.execPath)}, ["-e", ${JSON.stringify(source)}],
      ${JSON.stringify({ cwd, timeoutMs, terminationMs })});
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  `;
  let result;
  const started = performance.now();
  try {
    result = { ...await execute(process.execPath, ["--input-type=module", "-e", script], { cwd, timeout: 10_000, killSignal: "SIGKILL" }), code: 0 };
  } catch (error) {
    assert.equal(error.killed, false, `Supervisor did not exit within the test deadline. ${error.message}`);
    assert.equal(typeof error.code, "number", error.message);
    result = error;
  }
  const outcome = JSON.parse(result.stdout);
  assert.equal(result.code, outcome.exitCode);
  assert.equal(result.stderr, "");
  assert.equal(path.dirname(outcome.diagnosticsDirectory), path.join(cwd, "dev-temp", "msi-tests", "diagnostics"));
  const [stdout, stderr, log, terminationLog] = await Promise.all(["stdout.log", "stderr.log", "supervisor.log", "termination.log"]
    .map((name) => readFile(path.join(outcome.diagnosticsDirectory, name), "utf8")));
  return { ...outcome, cwd, stdout, stderr, log, terminationLog, elapsed: performance.now() - started };
}

test("Windows PowerShell selection preserves worker arguments and uses the launcher's sibling", async (t) => {
  const args = ["-Msi", "release/Downpad's build & test.msi", "-Scenario", "recovery", "-RecoverMissingExecutable", "-TimeoutSeconds", "45"];
  const invocation = powershellInvocation(args, "C:\\Windows");
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
  assert.deepEqual(invocation.args.slice(5), args);
  assert.throws(() => powershellInvocation([], ""), /SystemRoot/);

  const cwd = await fixture(t);
  const controls = path.join(cwd, "workflow-controls", "scripts");
  await mkdir(controls, { recursive: true });
  const copy = path.join(controls, "run-msi-test.mjs");
  await copyFile(launcher, copy);
  const imported = await import(pathToFileURL(copy).href);
  assert.equal(imported.powershellInvocation(args, "C:\\Windows").args[4], path.join(controls, "test-msi.ps1"));
});

test("CLI startup errors remain in diagnostics without depending on console output", async (t) => {
  const cwd = await fixture(t);
  const script = `
    Object.defineProperty(process, "platform", { value: "unsupported" });
    process.argv[1] = ${JSON.stringify(fileURLToPath(launcher))};
    await import(${JSON.stringify(launcher.href)});
  `;
  await assert.rejects(execute(process.execPath, ["--input-type=module", "-e", script], { cwd, timeout: 5000 }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "");
    return true;
  });
  const base = path.join(cwd, "dev-temp", "msi-tests", "diagnostics");
  const directories = await readdir(base);
  assert.equal(directories.length, 1);
  assert.match(await readFile(path.join(base, directories[0], "supervisor.log"), "utf8"), /Supervisor startup failed.*require Windows/);
});

test("success retains large stdout and stderr byte for byte and preserves source cwd", async (t) => {
  const result = await runWorker(t, `
    process.stdout.write(process.cwd() + "\\n" + "O".repeat(512 * 1024));
    process.stderr.write("E".repeat(512 * 1024));
  `);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${result.cwd}\n${"O".repeat(512 * 1024)}`);
  assert.equal(result.stderr, "E".repeat(512 * 1024));
  assert.match(result.log, /Started worker PID \d+/);
  assert.match(result.log, /Worker exited with code 0/);
  assert.ok(result.log.trim().split("\n").every((line) => /^\d{4}-\d\d-\d\dT\S+Z \+\d+ms /.test(line)));
});

test("worker failure preserves its exit status and diagnostics", async (t) => {
  const result = await runWorker(t, 'console.error("installation assertion failed"); process.exitCode = 7;');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr.trim(), "installation assertion failed");
  assert.match(result.log, /Finished with exit code 7/);
});

test("a spawn failure retains the original error and exits without waiting for the deadline", async (t) => {
  const result = await runWorker(t, "", { command: path.join(scratch, "missing-msi-test-worker") });
  assert.equal(result.exitCode, 1);
  assert.match(result.failure, /ENOENT/);
  assert.match(result.log, /ENOENT/);
  assert.doesNotMatch(result.log, /timed out/);
});

test("invalid deadlines and unavailable output fail before starting a worker", async (t) => {
  assert.throws(() => supervise(process.execPath, [], { timeoutMs: 10, terminationMs: 10 }), /deadline/);
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, "dev-temp"), "blocks diagnostics directory");
  assert.throws(() => supervise(process.execPath, ["-e", "process.exit(0)"], { cwd }), { syscall: "mkdir" });
});

test("a hung worker is stopped within the scenario deadline and retains its last output", async (t) => {
  const result = await runWorker(t, 'console.log("entered native call"); setTimeout(() => process.exit(99), 8000);', { timeoutMs: 5000, terminationMs: 3000 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.trim(), "entered native call");
  assert.match(result.failure, /timed out/);
  assert.match(result.log, /2000ms.*5000ms deadline/);
  assert.match(result.log, /Worker exited with code/);
  assert.ok(result.elapsed < 8000, `Unexpected duration ${result.elapsed}ms`);
});

test("timeout kills descendants holding output handles and leaves an unrelated child running", async (t) => {
  const unrelated = spawn(process.execPath, ["-e", 'setTimeout(() => process.exit(99), 8000)'], { stdio: "ignore" });
  const unrelatedExit = once(unrelated, "exit");
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    await unrelatedExit;
  });
  const result = await runWorker(t, `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", 'setTimeout(() => process.exit(99), 8000)'], { stdio: "inherit" });
    console.log(child.pid);
    setTimeout(() => process.exit(99), 8000);
  `, { timeoutMs: 4000, terminationMs: 2000 });
  assert.equal(result.exitCode, 1);
  assert.equal(process.kill(unrelated.pid, 0), true);
  const descendant = Number(result.stdout.trim());
  assert.ok(descendant > 0);
  // Linux can briefly retain a killed orphan as a zombie until its reaper runs.
  if (process.platform === "linux") {
    const state = await readFile(`/proc/${descendant}/stat`, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (state) assert.match(state, /^\d+ \(.+\) Z /);
  } else {
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  }
});

test("failed process-group termination falls back to the owned worker handle", { skip: process.platform === "win32" }, async (t) => {
  const result = await runWorker(t, 'setTimeout(() => process.exit(99), 8000);', {
    timeoutMs: 3000,
    setup: 'process.kill = () => { throw new Error("injected group termination failure"); };',
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.log, /injected group termination failure/);
  assert.match(result.log, /Sending SIGKILL to worker PID/);
  assert.match(result.log, /Worker exited with code/);
});

test("a supervisor log write error stops the worker and remains a failure", async (t) => {
  const result = await runWorker(t, 'setTimeout(() => process.exit(99), 8000);', {
    setup: `
      const fs = await import("node:fs");
      const { syncBuiltinESMExports } = await import("node:module");
      const original = fs.default.writeSync;
      let writes = 0;
      fs.default.writeSync = (...args) => {
        if (++writes === 2) throw new Error("injected diagnostic write failure");
        return original(...args);
      };
      syncBuiltinESMExports();
    `,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.failure, /injected diagnostic write failure/);
});

test("Windows termination helper failures cannot keep the supervisor alive", async (t) => {
  for (const mode of ["spawn-error", "hang"]) {
    await t.test(mode, async (t) => {
      const result = await runWorker(t, 'console.log(process.pid); setTimeout(() => process.exit(99), 8000);', {
        timeoutMs: 3000,
        setup: `
          const childProcess = await import("node:child_process");
          const { syncBuiltinESMExports } = await import("node:module");
          const assert = (await import("node:assert/strict")).default;
          const original = childProcess.default.spawn;
          Object.defineProperty(process, "platform", { value: "win32" });
          process.env.SystemRoot = "C:\\\\Windows";
          childProcess.default.spawn = (command, args, options) => {
            if (command.endsWith("taskkill.exe")) {
              assert.deepEqual(args, ["/PID", args[1], "/T", "/F"]);
              assert.match(args[1], /^\\d+$/);
              return original(${JSON.stringify(mode === "spawn-error" ? path.join(scratch, "missing-taskkill") : process.execPath)},
                ["-e", 'console.log("termination helper started"); setTimeout(() => process.exit(99), 8000);'], options);
            }
            return original(command, args, options);
          };
          syncBuiltinESMExports();
        `,
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.failure, /timed out/);
      assert.match(result.log, /Sending SIGKILL to worker PID/);
      if (mode === "spawn-error") {
        assert.match(result.log, /Tree termination failed.*ENOENT/);
      } else {
        assert.match(result.log, /Termination deadline reached/);
        assert.match(result.terminationLog, /termination helper started/);
      }
    });
  }
});
