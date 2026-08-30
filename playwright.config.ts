import { defineConfig, devices } from "@playwright/test";

// Frontend end-to-end tests run against the Vite dev server. Tauri-dependent
// integrations no-op behind isTauri(); installed-app/WebView2 smoke testing is
// performed separately from this browser suite.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
