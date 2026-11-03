import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Bundle the preload so Electron's sandbox does not need to load local modules.
await rm(new URL("../electron-dist", import.meta.url), { recursive: true, force: true });
await Promise.all([
  build({
    entryPoints: ["electron/main.ts"],
    outfile: "electron-dist/main.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["electron/preload.cts"],
    outfile: "electron-dist/preload.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
  }),
]);

// The Windows checker is a stable N-API addon. Ship its binary and license
// explicitly because the application bundles JavaScript and excludes node_modules.
if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("@arcstudio-labs/electron-system-spellcheck/package.json"));
  const addonRequire = createRequire(join(packageRoot, "package.json"));
  const binary = addonRequire("node-gyp-build").path(packageRoot);
  await mkdir(new URL("../electron-dist/licenses", import.meta.url), { recursive: true });
  await Promise.all([
    copyFile(binary, new URL("../electron-dist/spellcheck.node", import.meta.url)),
    copyFile(join(packageRoot, "LICENSE.md"), new URL("../electron-dist/licenses/electron-system-spellcheck.md", import.meta.url)),
    copyFile(join(dirname(addonRequire.resolve("node-addon-api/package.json")), "LICENSE.md"),
      new URL("../electron-dist/licenses/node-addon-api.md", import.meta.url)),
  ]);
}
