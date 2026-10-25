import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** Watch the parent directory so atomic file replacements stay observable. */
export function watchPath(path: string, changed: (modifiedMs: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void stat(path).then((info) => Math.floor(info.mtimeMs), () => 0).then((modified) => {
        if (!closed) changed(modified);
      });
    }, 75);
  };
  const watcher: FSWatcher = watch(dirname(path), (_event, fileName) => {
    if (fileName === null || fileName.toString() === basename(path)) schedule();
  });
  watcher.on("error", (error) => { console.error("Downpad file watch failed", error); });
  return () => { closed = true; if (timer) clearTimeout(timer); watcher.close(); };
}
