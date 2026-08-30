import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and does not want Vite to clear the screen so
// Rust compiler output stays visible. See https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

// Single source of truth for the displayed app version: package.json (kept in
// lockstep with tauri.conf.json / Cargo.toml). Injected at build time as the
// __APP_VERSION__ global so the Settings dialog can show it (spec §7).
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    // Don't watch the Rust backend; Tauri handles that.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Produce assets compatible with the WebView2 (Chromium) target.
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  // Expose TAURI_* env vars to the frontend if needed.
  envPrefix: ["VITE_", "TAURI_"],
  // Crepe bundles Vue for some of its UI; define Vue's compile-time flags to
  // silence the dev warning and enable production tree-shaking.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
});
