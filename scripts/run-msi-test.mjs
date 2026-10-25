import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Select Windows PowerShell 5.1 and forward the worker's arguments verbatim. */
export function powershellInvocation(args, systemRoot = process.env.SystemRoot) {
  if (!systemRoot) throw new Error("SystemRoot is required to locate Windows PowerShell 5.1.");
  return {
    command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./test-msi.ps1", import.meta.url)), ...args],
  };
}

/** Keep diagnostics in the source checkout even when controls come from elsewhere. */
function createDiagnosticsDirectory(cwd) {
  const base = path.join(cwd, "dev-temp", "msi-tests", "diagnostics");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, `supervisor-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
}

/** Run one worker with file-backed output and a deadline that includes termination. */
export function supervise(command, args, {
  cwd = process.cwd(),
  timeoutMs = 600_000,
  terminationMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || !Number.isSafeInteger(terminationMs)
    || terminationMs <= 0 || timeoutMs <= terminationMs || timeoutMs > 2_147_483_647) {
    throw new Error("The scenario deadline must exceed its positive termination budget.");
  }
  const started = performance.now();
  const diagnosticsDirectory = createDiagnosticsDirectory(cwd);
  const descriptors = [];
  let logFd;
  let stdoutFd;
  let stderrFd;
  let terminationFd;
  try {
    for (const name of ["supervisor.log", "stdout.log", "stderr.log", "termination.log"]) {
      descriptors.push(openSync(path.join(diagnosticsDirectory, name), "wx"));
    }
    [logFd, stdoutFd, stderrFd, terminationFd] = descriptors;
  } catch (error) {
    for (const fd of descriptors) {
      try { closeSync(fd); } catch { /* Preserve the original opening error. */ }
    }
    throw error;
  }

  return new Promise((resolve) => {
    let worker;
    let terminator;
    let workerExited = false;
    let terminatorExited = true;
    let stopping = false;
    let finished = false;
    let failure;
    let logFailed = false;
    let scenarioTimer;
    let terminationTimer;
    const onInterrupt = () => stop("Received SIGINT.");
    const onTerminate = () => stop("Received SIGTERM.");

    /** Keep records independent of console pipes and preserve logging failures. */
    function record(message) {
      if (logFailed) return;
      try {
        writeSync(logFd, `${new Date().toISOString()} +${Math.round(performance.now() - started)}ms ${message}\n`);
      } catch (error) {
        logFailed = true;
        failure ??= `Supervisor log write failed. ${error.message}`;
      }
    }

    /** Release all supervisor handles without waiting for child close events. */
    function finish(code = 1) {
      if (finished) return;
      finished = true;
      clearTimeout(scenarioTimer);
      clearTimeout(terminationTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      worker?.unref();
      terminator?.unref();
      record(`Finished with exit code ${failure ? 1 : code}.${failure ? ` ${failure}` : ""}`);
      for (const fd of descriptors.toReversed()) {
        try { closeSync(fd); } catch (error) { failure ??= `Diagnostic file close failed. ${error.message}`; }
      }
      resolve({ exitCode: failure ? 1 : code, diagnosticsDirectory, failure });
    }

    /** Fall back to the still-owned process handle, never a name or reused PID. */
    function killRoot() {
      if (!worker?.pid || workerExited) return;
      try {
        record(`Sending SIGKILL to worker PID ${worker.pid}.`);
        if (!worker.kill("SIGKILL")) record("Worker termination could not be confirmed.");
      } catch (error) {
        record(`Worker termination failed. ${error.message}`);
      }
    }

    /** Bound even a stuck taskkill helper and report unconfirmed cleanup. */
    function terminationExpired() {
      record("Termination deadline reached. Process tree cleanup is unconfirmed.");
      killRoot();
      if (terminator && !terminatorExited) {
        try { terminator.kill("SIGKILL"); } catch (error) { record(`Terminator stop failed. ${error.message}`); }
      }
      finish();
    }

    /** Stop only this worker's tree, reserving time inside the scenario deadline. */
    function stop(reason) {
      failure ??= reason;
      if (finished || stopping) return;
      stopping = true;
      clearTimeout(scenarioTimer);
      record(reason);
      if (!worker?.pid || workerExited) {
        finish();
        return;
      }
      terminationTimer = setTimeout(terminationExpired,
        Math.max(0, Math.min(terminationMs, timeoutMs - (performance.now() - started))));
      if (process.platform !== "win32") {
        try {
          // A detached POSIX worker leads a new process group used by Linux tests.
          process.kill(-worker.pid, "SIGKILL");
          record(`Sent SIGKILL to worker process group ${worker.pid}.`);
        } catch (error) {
          record(`Process group termination failed. ${error.message}`);
          killRoot();
        }
        return;
      }
      try {
        const taskkill = path.win32.join(process.env.SystemRoot, "System32", "taskkill.exe");
        record(`Stopping worker tree with taskkill /PID ${worker.pid} /T /F.`);
        terminator = spawn(taskkill, ["/PID", String(worker.pid), "/T", "/F"], {
          cwd, windowsHide: true, stdio: ["ignore", terminationFd, terminationFd],
        });
        terminatorExited = false;
        terminator.on("error", (error) => {
          record(`Tree termination failed. Cleanup is unconfirmed. ${error.message}`);
          terminatorExited = true;
          killRoot();
          if (workerExited) finish();
        });
        terminator.on("exit", (code, signal) => {
          terminatorExited = true;
          record(`Tree terminator exited with code ${code}, signal ${signal}.`);
          if (code !== 0) {
            record("Process tree cleanup is unconfirmed.");
            killRoot();
          }
          if (workerExited) finish();
        });
      } catch (error) {
        record(`Could not launch tree termination. Cleanup is unconfirmed. ${error.message}`);
        killRoot();
      }
    }

    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    record(`Starting ${JSON.stringify({ command, args, cwd })}. Scenario deadline ${timeoutMs}ms, termination budget ${terminationMs}ms.`);
    if (failure) {
      finish();
      return;
    }
    scenarioTimer = setTimeout(() => stop(`Scenario timed out after ${timeoutMs - terminationMs}ms. Termination is included in the ${timeoutMs}ms deadline.`),
      Math.max(0, timeoutMs - terminationMs - (performance.now() - started)));
    try {
      worker = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      worker.on("spawn", () => {
        record(`Started worker PID ${worker.pid}.`);
        if (failure) stop(failure);
      });
      worker.on("error", (error) => stop(`Worker process failed. ${error.message}`));
      worker.on("exit", (code, signal) => {
        workerExited = true;
        record(`Worker exited with code ${code}, signal ${signal}.`);
        if (!stopping || terminatorExited) finish(code ?? 1);
      });
    } catch (error) {
      stop(`Worker spawn failed. ${error.message}`);
    }
  });
}

/** Exit independently of console pipes, which can block synchronously on Windows. */
async function main() {
  let exitCode = 1;
  try {
    if (process.platform !== "win32") throw new Error("MSI integration tests require Windows.");
    const invocation = powershellInvocation(process.argv.slice(2));
    const result = await supervise(invocation.command, invocation.args);
    exitCode = result.exitCode;
  } catch (error) {
    try {
      const directory = createDiagnosticsDirectory(process.cwd());
      writeFileSync(path.join(directory, "supervisor.log"), `${new Date().toISOString()} Supervisor startup failed. ${error.message}\n`, { flag: "wx" });
    } catch { /* No child was started if diagnostic initialization failed. */ }
  }
  // Diagnostic files are closed, including after an unconfirmed forced stop.
  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
