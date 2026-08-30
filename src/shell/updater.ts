// Manual update check (spec §7). Wraps the Tauri updater so the Settings dialog
// can offer a "Check for updates" button. Degrades gracefully: if no updater is
// configured (no release endpoint/signing key yet) or the network is down, it
// returns a friendly message instead of throwing.

import { isTauri } from "../ipc/env";

export async function checkForUpdates(): Promise<string> {
  if (!isTauri()) return "Updates are only available in the installed app.";
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return "You're on the latest version.";
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const install = await ask(`Version ${update.version} is available. Install it now?`, {
      title: "Update available",
      kind: "info",
    });
    if (!install) return `Update ${update.version} is available.`;
    await update.downloadAndInstall();
    return "Update installed — restart md-easy to apply.";
  } catch {
    return "Couldn't check for updates (none configured, or you're offline).";
  }
}
