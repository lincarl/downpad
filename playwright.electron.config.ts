import { defineConfig } from "@playwright/test";

// These tests launch the desktop app and use its real preload and main process.
export default defineConfig({
  testDir: "./e2e-electron",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "dev-temp/electron-test-results",
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
