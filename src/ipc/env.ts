// Detects whether we're running inside the Tauri runtime (vs. a plain browser,
// e.g. `vite` for dev or Playwright e2e). Tauri 2 injects __TAURI_INTERNALS__.
// Backend-dependent features must guard on this so the app still loads in a
// browser.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
