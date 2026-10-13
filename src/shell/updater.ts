// No Electron update service is configured. Do not report a version check or
// installation as successful until the app has a working release endpoint.

import { isElectron } from "../ipc/env";

export async function checkForUpdates(): Promise<string> {
  if (!isElectron()) return "Updates are only available in the installed app.";
  return "Automatic updates aren't configured. Install a newer release to update md-easy.";
}
