// Thin wrapper around the Tauri CLI, used by the "tauri" npm script.
//
// Why this exists: on Windows, when you close the app window during
// `pnpm tauri dev`, the Tauri CLI force-kills the Vite dev server (the
// beforeDevCommand) with an aggressive taskkill. That child then returns
// 4294967295 (0xFFFFFFFF / -1), and the CLI propagates it as its own exit code,
// so pnpm prints "[ELIFECYCLE] Command failed with exit code 4294967295" on
// every clean close. It's purely cosmetic — the app itself exits 0 (see the
// RunEvent::Exit handler in src-tauri/src/lib.rs) and the dev session shut down
// normally — but it's noise on every run.
//
// So: for the `dev` subcommand we swallow the exit code and report 0. Every
// other subcommand (build, signer, icon, ...) passes its real exit code
// through, so genuine failures (e.g. a failed `tauri build`) still surface.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

// `shell: true` so the platform shell resolves the local `tauri` bin
// (node_modules/.bin/tauri[.cmd]); pnpm puts that on PATH for script runs.
const result = spawnSync("tauri", args, { stdio: "inherit", shell: true });

if (args[0] === "dev") {
  // Normal close / Ctrl+C tears down the dev server with a nonzero code we don't
  // care about. Anything that actually mattered already printed to the terminal.
  process.exit(0);
}

// Non-dev: mirror the CLI's real result (null status == killed by signal).
process.exit(result.status ?? 1);
