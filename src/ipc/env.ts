// Electron exposes its isolated preload API on window.downpadDesktop. Browser previews
// have no native API and keep their development and test fallback behavior. The
// name has a capital letter, because a page element's id also becomes a window
// property where no real one exists, and the editor gives a heading a lowercase
// id made from its text, so a heading "Downpad" in a preview is window.downpad.

import type {} from "./bridge";

export function isElectron(): boolean {
  return typeof window !== "undefined" && window.downpadDesktop !== undefined;
}
