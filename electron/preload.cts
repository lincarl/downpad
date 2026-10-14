import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { DesktopCommandArgs, DesktopCommandResults, DesktopEventPayloads, ElectronBridge } from "../src/ipc/bridge";

const commands = new Set<keyof DesktopCommandArgs>([
  "read_file", "write_file", "path_exists", "watch_file", "unwatch_file", "ensure_attachments_dir", "write_attachment",
  "read_image_bytes", "get_recent_files", "record_file_opened", "remove_recent", "set_favorite", "stat_files",
  "search_recent_contents", "cancel_search", "write_snapshot", "delete_snapshot", "list_recovery_snapshots",
  "get_launch_args", "get_default_md_handler", "open_default_apps_settings", "get_system_accent_color",
  "load_settings", "save_settings", "settings_path", "list_printers", "print_webview", "print_webview_to_pdf",
]);
const events = new Set<keyof DesktopEventPayloads>([
  "settings-changed", "file-changed", "open-file-requested", "print-completed", "search-result", "close-requested",
]);
let closeListeners = 0;
let openListeners = 0;

const bridge: ElectronBridge = {
  platform: process.platform,
  invoke<K extends keyof DesktopCommandArgs>(command: K, args?: DesktopCommandArgs[K]): Promise<DesktopCommandResults[K]> {
    if (!commands.has(command)) return Promise.reject(new Error("Unknown desktop command."));
    return ipcRenderer.invoke("md-easy:invoke", command, args) as Promise<DesktopCommandResults[K]>;
  },
  listen<K extends keyof DesktopEventPayloads>(event: K, handler: (payload: DesktopEventPayloads[K]) => void): () => void {
    if (!events.has(event)) throw new Error("Unknown desktop event.");
    const channel = `md-easy:event:${event}`;
    const listener = (_event: IpcRendererEvent, payload: DesktopEventPayloads[K]): void => handler(payload);
    ipcRenderer.on(channel, listener);
    if (event === "close-requested" && ++closeListeners === 1) ipcRenderer.send("md-easy:close-listener", true);
    if (event === "open-file-requested" && ++openListeners === 1) ipcRenderer.send("md-easy:open-listener", true);
    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      ipcRenderer.removeListener(channel, listener);
      if (event === "close-requested" && --closeListeners === 0) ipcRenderer.send("md-easy:close-listener", false);
      if (event === "open-file-requested" && --openListeners === 0) ipcRenderer.send("md-easy:open-listener", false);
    };
  },
  openDialog: (options) => ipcRenderer.invoke("md-easy:dialog-open", options),
  saveDialog: (options) => ipcRenderer.invoke("md-easy:dialog-save", options),
  ask: (message, options) => ipcRenderer.invoke("md-easy:dialog-ask", message, options),
  openExternal: (url) => ipcRenderer.invoke("md-easy:open-external", url),
  revealItemInFolder: (path) => ipcRenderer.invoke("md-easy:reveal-item", path),
  setTheme: (theme) => ipcRenderer.invoke("md-easy:set-theme", theme),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  convertFileSrc: (path) => ipcRenderer.invoke("md-easy:image-url", path),
  closeWindow: () => ipcRenderer.invoke("md-easy:close-window"),
  cancelWindowClose: () => ipcRenderer.invoke("md-easy:cancel-window-close"),
};

contextBridge.exposeInMainWorld("mdEasy", Object.freeze(bridge));
