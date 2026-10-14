import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.MD_EASY_DEV_HOST;

// Electron and the Settings dialog use the package version.
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    allowedHosts: process.env.MD_EASY_DEV_HOSTNAME
      ? [process.env.MD_EASY_DEV_HOSTNAME]
      : [],
    watch: { ignored: ["**/electron/**", "**/electron-dist/**", "**/release/**"] },
  },
  // Electron loads the packaged frontend from disk.
  build: {
    target: "es2022",
    sourcemap: !!process.env.MD_EASY_DEBUG,
  },
  // Crepe bundles Vue for some of its UI; define Vue's compile-time flags to
  // silence the dev warning and enable production tree-shaking.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
});
