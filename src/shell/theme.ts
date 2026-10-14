// Theme application (spec §6.2). Sets two attributes on the root element:
//   - data-theme       → the UI (chrome) palette
//   - data-editor-theme → the document/text palette
// The document theme can follow the UI theme or be pinned independently, so a
// dark-UI user can still read documents on a light page (and vice versa). The
// CSS in styles/app.css provides the light/dark palettes. "system" follows the
// OS for the UI (and, when the document follows the UI, for the document too).

import type { Settings } from "../state/types";
import { isElectron } from "../ipc/env";
import { desktopBridge } from "../ipc/bridge";

let disposeActiveSystemTheme: (() => void) | null = null;

export function applyTheme(
  uiTheme: Settings["theme"],
  editorTheme: Settings["editorTheme"],
): () => void {
  const root = document.documentElement;

  // Applying a new theme supersedes the previous live system subscription.
  // Keep this cleanup at module scope as well as returning it to the owner: it
  // preserves applyTheme's historical "latest call wins" behavior for callers
  // that do not retain the disposer.
  disposeActiveSystemTheme?.();
  disposeActiveSystemTheme = null;

  const apply = (systemDark: boolean): void => {
    const ui = uiTheme === "system" ? (systemDark ? "dark" : "light") : uiTheme;
    root.setAttribute("data-theme", ui);
    const editor = editorTheme === "follow-ui" ? ui : editorTheme;
    root.setAttribute("data-editor-theme", editor);
    syncNativeWindowTheme(ui);
  };

  // A system listener is only needed when the resolved theme depends on the OS,
  // i.e. when the UI follows the system (the document either follows the UI or
  // is pinned, so it never independently needs the OS signal).
  if (uiTheme === "system") {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void => apply(event.matches);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      query.removeEventListener("change", onChange);
      if (disposeActiveSystemTheme === dispose) disposeActiveSystemTheme = null;
    };

    apply(query.matches);
    query.addEventListener("change", onChange);
    disposeActiveSystemTheme = dispose;
    return dispose;
  } else {
    apply(false);
    return () => {};
  }
}

/** Keep Windows/macOS native title chrome on the same palette as the webview. */
function syncNativeWindowTheme(theme: "light" | "dark"): void {
  if (!isElectron()) return;
  void desktopBridge().setTheme(theme)
    .catch(() => {
      // Theme sync is cosmetic; startup and editing must remain usable if the
      // platform does not implement it or the window is already closing.
    });
}
