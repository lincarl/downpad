import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.DOWNPAD_DEV_HOST;

// Electron and the Settings dialog use the package version.
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// On Downpad's file:// page, 'self' matches every local file: URL. Scripts load
// only from there, never inline, through eval or from the web.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // CodeMirror, KaTeX and Mermaid's diagrams add inline styles.
  "style-src 'self' 'unsafe-inline'",
  // Web and embedded images, local images through downpad-file: or file: URLs,
  // and the blob: URL Copy image converts through.
  "img-src 'self' data: blob: https: http: downpad-file:",
  // Vite inlines one of KaTeX's fonts as a data: URL.
  "font-src 'self' data:",
  // The welcome document, and Copy image on an embedded image.
  "connect-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Add the Content Security Policy to the built index.html. The dev server's
 *  React refresh runs an inline script, so development pages go without it. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "downpad-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [{
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
      injectTo: "head-prepend",
    }],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    allowedHosts: process.env.DOWNPAD_DEV_HOSTNAME
      ? [process.env.DOWNPAD_DEV_HOSTNAME]
      : [],
    watch: {
      // dev-temp holds scratch files, often tens of thousands of them, and
      // watching them all runs out of the system's file watches. The path is
      // anchored here, because a checkout can itself sit in another dev-temp.
      ignored: ["**/electron/**", "**/electron-dist/**", "**/release/**", `${fileURLToPath(new URL("./dev-temp/", import.meta.url))}**`],
    },
  },
  // Electron loads the packaged frontend from disk.
  build: {
    target: "es2022",
    sourcemap: !!process.env.DOWNPAD_DEBUG,
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
