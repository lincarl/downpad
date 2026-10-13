import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";
import electron from "electron";

const require = createRequire(import.meta.url);
const children = new Set();
let server;
let stopping = false;

function startChild(command, args, options) {
  const child = spawn(command, args, options);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function runNodeScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = startChild(process.execPath, [script, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Desktop build exited with ${signal ?? code}`));
    });
  });
}

// The script owns Vite and every child, including the initial compiler process.
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
  await server?.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await runNodeScript(require.resolve("typescript/bin/tsc"), ["-p", "electron/tsconfig.json"]);
  if (!stopping) await import("./build-desktop.mjs");
  if (!stopping) {
    server = await createServer();
    if (!stopping) await server.listen();
    if (stopping) {
      await server.close();
    } else {
      server.printUrls();
      const child = startChild(electron, [".", ...process.argv.slice(2)], {
        stdio: "inherit",
        env: {
          ...process.env,
          MD_EASY_DEV_URL: server.resolvedUrls?.local[0] ?? "http://127.0.0.1:1420",
        },
      });
      child.once("error", (error) => {
        console.error(error);
        void shutdown(1);
      });
      child.once("exit", (code, signal) => {
        void shutdown(signal === "SIGTERM" ? 0 : code ?? 1);
      });
    }
  }
} catch (error) {
  if (!stopping) {
    console.error(error);
    await shutdown(1);
  }
}
