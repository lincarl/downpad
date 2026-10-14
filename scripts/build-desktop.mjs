import { build } from "esbuild";
import { rm } from "node:fs/promises";

// Bundle the preload so Electron's sandbox does not need to load local modules.
await rm(new URL("../electron-dist", import.meta.url), { recursive: true, force: true });
await Promise.all([
  build({
    entryPoints: ["electron/main.ts"],
    outfile: "electron-dist/main.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["electron/preload.cts"],
    outfile: "electron-dist/preload.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
  }),
]);
