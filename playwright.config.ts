import { defineConfig, devices } from "@playwright/test";

// Browser tests exercise the web adapter. Native filesystem and printing flows
// run separately through playwright.electron.config.ts.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    channel: process.env.MD_EASY_BROWSER_CHANNEL,
  },
  webServer: {
    command: "pnpm dev:web",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
