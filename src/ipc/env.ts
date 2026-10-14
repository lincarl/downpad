// Electron exposes its isolated preload API on window.mdEasy. Browser previews
// have no native API and keep their development and test fallback behavior.

import type {} from "./bridge";

export function isElectron(): boolean {
  return typeof window !== "undefined" && window.mdEasy !== undefined;
}
