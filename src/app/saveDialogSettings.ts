// The Settings dialog's save, which undoes settings that could not be written
// and checks Git again once a write turns it on.

import type { GitSync } from "../git/GitSync";
import type { SettingsModel } from "../settings/SettingsModel";
import type { Store } from "../state/store";
import type { Settings } from "../state/types";

export interface DialogSaveDependencies {
  store: Store;
  settings: Pick<SettingsModel, "save">;
  git: Pick<GitSync, "check">;
}

/** Save the Settings dialog's settings, and resolve whether they were
 *  written. A failed write puts the settings from before back. Settings apply
 *  locally before they reach the main process, so a write that turns Git on
 *  checks again once the main process's Git guard can see it. A failed write
 *  never checks, and a retry that is written then does. */
export async function saveDialogSettings(
  next: Settings,
  { store, settings, git }: DialogSaveDependencies,
): Promise<boolean> {
  const enablingGit = next.gitEnabled && !store.get().settings.gitEnabled;
  const written = await settings.save(next, { undoIfUnwritten: true });
  if (enablingGit && written) void git.check({ force: true });
  return written;
}
