import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// __APP_VERSION__ is injected by vite.config.ts at build time; mirror it here so
// modules referencing it (e.g. the Settings dialog) don't hit an undefined
// global under Vitest, which uses this config rather than vite.config.ts.
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Unit tests only. End-to-end browser tests live in e2e/ and run under
// Playwright, not Vitest.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
